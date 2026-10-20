const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { buildSync } = require('esbuild');

function load(source, vscode = {}) {
  const { outputFiles } = buildSync({ entryPoints: [source], bundle: true, write: false,
    platform: 'node', format: 'cjs', external: ['vscode', 'vscode-textmate', 'vscode-oniguruma'] });
  const module = { exports: {} };
  vm.runInNewContext(outputFiles[0].text, { module, exports: module.exports, Buffer, setImmediate,
    require: name => name === 'vscode' ? vscode : require(name) });
  return module.exports;
}

function workerFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-large-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workerPath = path.join(root, 'dist', 'fileCompareWorker.js');
  buildSync({ entryPoints: ['src/fileCompareWorker.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: workerPath });
  return { root, workerPath };
}

test('large panel accepts exact 20 MB and 200,000-line limits, caches comparisons and rejects larger inputs', async t => {
  const { root } = workerFixture(t);
  const { MAX_FILE_BYTES, MAX_FILE_LINES } = load('src/fileComparison.ts');
  const uri = fsPath => ({ fsPath, toString: () => fsPath });
  let receive, dispose;
  const posted = [];
  let text = Array.from({ length: MAX_FILE_LINES }, (_, i) => `record ${i}: sample value`).join('\n');
  const vscode = {
    Uri: { joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
    ViewColumn: { Active: 1 },
    window: { createWebviewPanel: () => ({
      webview: { asWebviewUri: u => u.fsPath, cspSource: 'test',
        onDidReceiveMessage: cb => { receive = cb; return { dispose() {} }; },
        postMessage: message => posted.push(message) },
      onDidDispose: cb => { dispose = cb; },
    }) },
    workspace: { textDocuments: [], fs: { readFile: async () => Buffer.from(text) } },
  };
  const { createFileComparePanel } = load('src/filePanel.ts', vscode);
  createFileComparePanel({ extensionUri: uri(root) }, uri('/left.txt'), uri('/right.txt'));
  t.after(() => dispose());
  await receive({ type: 'ready' });
  let result = posted.at(-1);
  assert.equal(result.type, 'result');
  assert.equal(result.largeFile, true);
  assert.equal(result.rows.length, MAX_FILE_LINES);
  assert.equal(result.rows.some(row => row.changed), false);
  assert.equal(result.rows[0].left.text, undefined);
  assert.equal(result.rows[0].left.key, undefined);
  posted.length = 0;
  await receive({ type: 'reload' });
  assert.equal(posted.at(-1).type, 'result');
  assert.equal(posted.some(message => message.stage === 'Comparing lines' && message.completed !== undefined), false);
  posted.length = 0;
  text += '\nextra';
  await receive({ type: 'reload' });
  assert.match(posted.at(-1).message, /200,000 lines/);
  text = 'x'.repeat(MAX_FILE_BYTES);
  posted.length = 0;
  await receive({ type: 'reload' });
  result = posted.at(-1);
  assert.equal(result.type, 'result');
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].changed, false);
  text += 'x';
  posted.length = 0;
  await receive({ type: 'reload' });
  assert.match(posted.at(-1).message, /20 MB/);
});

test('worker keeps the parent responsive, reports progress, and can be cancelled or fail cleanly', async t => {
  const { workerPath } = workerFixture(t);
  const { startFileComparison } = load('src/fileComparison.ts');
  const texts = Array.from({ length: 2 }, (_, side) => Array.from({ length: 30000 }, (_, i) => `value ${side}: ${i}`).join('\n'));
  const options = { includeWhitespace: false, includeComments: true };
  const updates = [];
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  let rows;
  try { rows = await startFileComparison(workerPath, texts, 'txt', options, (done, total) => updates.push([done, total])).result; }
  finally { clearInterval(timer); }
  assert.ok(ticks > 0);
  assert.equal(rows.length, 30000);
  assert.equal(rows.every(row => row.changed), true);
  assert.equal(rows.some(row => row.leftChanges || row.rightChanges), false);
  assert.equal(updates.at(-1)[0], updates.at(-1)[1]);
  const job = startFileComparison(workerPath, texts, 'txt', options, () => {});
  job.cancel();
  await assert.rejects(job.result, /superseded/);
  await assert.rejects(startFileComparison(path.join(workerPath, 'missing.js'), texts, 'txt', options, () => {}).result);
});

test('work-budget fallback preserves equal ends and limits long-line character work', () => {
  const { compareFileText, diffLines } = load('src/fileDiff.ts');
  const make = keys => keys.map((key, i) => ({ number: i + 1, key, text: key }));
  const rows = diffLines(make(['head', 'a', 'b', 'tail']), make(['head', 'x', 'y', 'tail']), 0);
  assert.deepEqual(Array.from(rows, row => row.changed), [false, true, true, false]);
  const large = compareFileText('a'.repeat(100000), 'b'.repeat(100000), 'txt', { includeWhitespace: false, includeComments: true });
  assert.equal(large[0].changed, true);
  assert.equal(large[0].leftChanges, undefined);
});

test('comment scanner copies runs without changing strings, source offsets or compressed spans', () => {
  const { stripComments } = load('src/compare.ts');
  const cases = [
    ['ts', 'const url = "https://x"; /* old */foo(); // tail\nnext();', 'const url = "https://x";  foo(); \nnext();'],
    ['ts', '"a\\\"//keep"; / divide; /* multi\nline */x', '"a\\\"//keep"; / divide; \nx'],
    ['py', '"""a # keep\nb""" # tail\nx', '"""a # keep\nb""" \nx'],
    ['sql', "select '--keep'; -- remove\nx", "select '--keep'; \nx"],
    ['xml', '<x>before<!-- block -->after</x>', '<x>before after</x>'],
    ['txt', 'a // keep', 'a // keep'],
    ['ts', '"' + '\\\\'.repeat(30000), '"' + '\\\\'.repeat(30000)],
  ];
  for (const [ext, source, expected] of cases) {
    const offsets = [], spans = [];
    const filtered = stripComments(source, ext, offsets, spans);
    assert.equal(filtered, expected);
    const expanded = spans.flatMap(span => Array.from({ length: span.length }, (_, i) => span.sourceStart < 0 ? -1 : span.sourceStart + i));
    assert.deepEqual(expanded, offsets);
    offsets.forEach((offset, i) => { if (offset >= 0) assert.equal(filtered[i], source[offset]); });
  }
});

test('large syntax mode keeps editor preferences without loading grammars or opening documents', async () => {
  const vscode = {
    extensions: { get all() { throw new Error('Grammars should not be loaded'); } },
    workspace: { getConfiguration: () => ({ get: key => key === 'tabSize' ? 8 : undefined }),
      openTextDocument: () => { throw new Error('Document should not be opened'); } },
  };
  const { getFileSyntax } = load('src/fileSyntax.ts', vscode);
  const result = await getFileSyntax({}, [], [], undefined, false);
  assert.equal(result.editor.tabSize, 8);
  assert.equal(result.tokens.length, 0);
});

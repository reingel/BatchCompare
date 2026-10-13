const assert = require('node:assert/strict');
const vm = require('node:vm');
const { test } = require('node:test');
const { buildSync } = require('esbuild');
function load(source, vscode = {}) {
  const { outputFiles } = buildSync({ entryPoints: [source], bundle: true, write: false,
    platform: 'node', format: 'cjs', external: ['vscode', 'vscode-textmate', 'vscode-oniguruma'] });
  const module = { exports: {} };
  vm.runInNewContext(outputFiles[0].text, { module, exports: module.exports, Buffer, setImmediate,
    require: name => name === 'vscode' ? vscode : require(name) });
  return module.exports;
}
const { projectLines, diffLines, compareFileText } = load('src/fileDiff.ts');
const options = (whitespace, comments) => ({ includeWhitespace: whitespace, includeComments: comments });
const compare = (a, b, opts, ext = 'ts') => diffLines(projectLines(a, ext, opts), projectLines(b, ext, opts));

test('whitespace and comment switches independently control file differences', () => {
  const a = 'const x = 1; // old\n';
  const b = 'const  x = 1; // new\n';
  for (const whitespace of [true, false]) for (const comments of [true, false]) {
    assert.equal(compare(a, b, options(whitespace, comments)).some(row => row.changed), whitespace || comments);
  }
  assert.equal(compare('a\n', '\n a \n\n', options(false, true)).some(row => row.changed), false);
});

test('comment matching preserves source text, source numbers and strings', () => {
  const lines = projectLines('// header\nconst url = "https://example.com";\n/* multi\nline */\nconst x = 1; // tail', 'ts', options(true, false));
  assert.deepEqual(Array.from(lines, line => line.number), [2, 5]);
  assert.equal(lines[0].text, 'const url = "https://example.com";');
  assert.equal(lines[1].text, 'const x = 1; // tail');
  assert.equal(compare('const x = 1;\n', '// header\nconst x = 1; // tail\n', options(true, false)).some(row => row.changed), false);
  assert.equal(compare('x = "# text" # old', 'x = "# text" # new', options(true, false), 'py').some(row => row.changed), false);
  assert.equal(compare('text # old', 'text # new', options(true, false), 'txt').some(row => row.changed), true);
});

test('all source lines stay visible for every combination of switches, including comment-only and blank lines', () => {
  const left = '// old header\n\nconst x = 1; // old\n/* block\ncomment */\nconst y = 2;\n';
  const right = 'const x = 1; // new\n\nconst y = 2;\n// footer\n';
  for (const whitespace of [true, false]) for (const comments of [true, false]) {
    const rows = compareFileText(left, right, 'ts', options(whitespace, comments));
    for (const [side, source] of [['left', left], ['right', right]]) {
      assert.equal(Array.from(rows.filter(row => row[side]), row => row[side].text).join('\n'), source);
      assert.deepEqual(Array.from(rows.filter(row => row[side]), row => row[side].number), source.split('\n').map((_, i) => i + 1));
    }
    if (!whitespace && !comments) assert.equal(rows.some(row => row.changed), false);
  }
  const onlyComments = compareFileText('// left', '/* right */\n', 'ts', options(true, false));
  assert.equal(onlyComments.some(row => row.changed), false);
  assert.equal(onlyComments[0].left.text, '// left');
});

test('line diff aligns inserts/deletes and reconstructs both inputs with duplicate lines', () => {
  let seed = 123;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; };
  for (let iteration = 0; iteration < 150; iteration++) {
    const make = () => Array.from({ length: random() % 30 }, (_, i) => ({ number: i + 1, text: String(random() % 5), key: String(seed % 5) }));
    const a = make(), b = make();
    const rows = diffLines(a, b);
    assert.deepEqual(Array.from(rows.filter(row => row.left), row => row.left), a);
    assert.deepEqual(Array.from(rows.filter(row => row.right), row => row.right), b);
    for (const row of rows.filter(row => !row.changed)) assert.equal(row.left.key, row.right.key);
  }
  const rows = compare('a\nb\nc', 'a\nx\nb\nc', options(true, true));
  assert.equal(rows.filter(row => row.changed).length, 1);
  assert.equal(rows.find(row => row.changed).right.number, 2);
});

test('file panel inherits options, refreshes dirty documents, rejects binary and disposes its listener', async () => {
  let receive, dispose, listenerDisposed = false;
  const posted = [], commands = [];
  const uri = name => ({ fsPath: name, toString: () => name });
  const left = uri('/left.ts'), right = uri('/right.ts');
  const documents = [{ uri: left, getText: () => 'let x = 1; // old' }, { uri: right, getText: () => 'let x = 1; // new' }];
  const vscode = {
    Uri: { joinPath: (base, ...parts) => uri([base.fsPath, ...parts].join('/')) },
    ViewColumn: { Active: 1 },
    window: { createWebviewPanel: () => ({
      webview: { asWebviewUri: u => u.fsPath, cspSource: 'test',
        onDidReceiveMessage: callback => { receive = callback; return { dispose: () => { listenerDisposed = true; } }; },
        postMessage: message => posted.push(message) },
      onDidDispose: callback => { dispose = callback; },
    }) },
    workspace: { textDocuments: documents, fs: { readFile: async () => Buffer.from('\0binary') } },
    commands: { executeCommand: (...args) => commands.push(args) },
  };
  const { createFileComparePanel } = load('src/filePanel.ts', vscode);
  createFileComparePanel({ extensionUri: uri('/extension') }, left, right, options(true, false));
  await receive({ type: 'ready' });
  assert.equal(posted.at(-1).rows.some(row => row.changed), false);
  await receive({ type: 'toggle', option: 'comment' });
  assert.equal(posted.at(-1).rows.some(row => row.changed), true);
  documents[1].getText = () => documents[0].getText();
  await receive({ type: 'reload' });
  assert.equal(posted.at(-1).rows.some(row => row.changed), false);
  documents.length = 0;
  await receive({ type: 'reload' });
  assert.equal(posted.at(-1).type, 'error');
  await receive({ type: 'original' });
  assert.equal(commands[0][0], 'vscode.diff');
  dispose();
  assert.equal(listenerDisposed, true);
});

test('language colors use the installed grammar, inherited JSONC theme and user token customizations', async t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-syntax-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'media'));
  fs.copyFileSync('node_modules/vscode-oniguruma/release/onig.wasm', path.join(root, 'media', 'onig.wasm'));
  fs.writeFileSync(path.join(root, 'grammar.json'), JSON.stringify({ scopeName: 'source.fixture', patterns: [
    { name: 'comment.block.fixture', begin: '/\\*', end: '\\*/' },
    { name: 'comment.line.fixture', match: '//.*$' },
    { name: 'keyword.fixture', match: '\\bconst\\b' },
  ] }));
  fs.writeFileSync(path.join(root, 'parent.json'), JSON.stringify({ tokenColors: [{ scope: 'keyword', settings: { foreground: '#123456' } }] }));
  fs.writeFileSync(path.join(root, 'theme.json'), '{ // JSONC theme\n"include": "parent.json", "colors": {"editor.foreground":"#eeeeee"}, "tokenColors": [{"scope":"comment", "settings":{"foreground":"#654321"}}]}');
  const uri = fsPath => ({ fsPath });
  const vscode = {
    Uri: { joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
    ColorThemeKind: { Light: 1 }, window: { activeColorTheme: { kind: 2 } },
    extensions: { all: [{ extensionPath: root, packageJSON: { contributes: {
      grammars: [{ language: 'fixture', scopeName: 'source.fixture', path: 'grammar.json' }],
      themes: [{ id: 'fixture-theme', label: 'Fixture', path: 'theme.json' }],
    } } }] },
    workspace: {
      openTextDocument: async () => ({ languageId: 'fixture' }),
      getConfiguration: section => ({ get: (key, fallback) => {
        if (section === 'workbench' && key === 'colorTheme') return 'fixture-theme';
        if (key === 'tokenColorCustomizations') return { '[fixture-theme]': { comments: '#abcdef' } };
        return fallback;
      } }),
    },
  };
  const { getFileSyntax } = load('src/fileSyntax.ts', vscode);
  const result = await getFileSyntax({ extensionUri: uri(root) }, [uri('/example.fixture')], ['const x = 1; // comment\n/* block\nstill comment */']);
  const colors = result.tokens[0].map(tokens => tokens.filter((_, i) => i % 2 === 1).map(metadata => result.colors[(metadata >>> 15) & 511]));
  assert.equal(colors[0][0].toLowerCase(), '#123456');
  assert.equal(colors[0].at(-1).toLowerCase(), '#abcdef');
  assert.equal(colors[1][0].toLowerCase(), '#abcdef');
  assert.equal(colors[2][0].toLowerCase(), '#abcdef');
});

test('rgba webview theme colors are converted to Monaco hex instead of its red error fallback', () => {
  const { toMonacoColor } = load('media/fileColors.js');
  assert.equal(toMonacoColor('rgba(121, 121, 121, 0.4)', '#000000'), '#79797966');
  assert.equal(toMonacoColor('rgba(100, 100, 100, 0.7)', '#000000'), '#646464b3');
  assert.equal(toMonacoColor('rgb(191, 191, 191)', '#000000'), '#bfbfbf');
  assert.equal(toMonacoColor('transparent', '#ffffff'), '#00000000');
  assert.equal(toMonacoColor('invalid', '#79797966'), '#79797966');
});

test('RingBuffer comment-only modification loses highlight when comments are disabled; trailing whitespace remains independent', () => {
  const left = '#include <vector>\n/*\nABC\n125\n*/\n\nnamespace SimNav { \n}\n';
  const right = left.replace('125', '123').replace('SimNav { ', 'SimNav {');
  assert.equal(compareFileText(left, right, 'hpp', options(false, true)).filter(row => row.changed).length, 1);
  assert.equal(compareFileText(left, right, 'hpp', options(false, false)).filter(row => row.changed).length, 0);
  const whitespaceOnly = compareFileText(left, right, 'hpp', options(true, false)).filter(row => row.changed);
  assert.equal(whitespaceOnly.length, 1);
  assert.equal(whitespaceOnly[0].left.text, 'namespace SimNav { ');
});

function highlightedText(line, ranges) {
  return Array.from(ranges ?? [], range => line.text.slice(range.startColumn - 1, range.endColumn - 1));
}

test('inline diff marks separate changed columns while leaving equal characters neutral', () => {
  const row = compareFileText('value = 123; other = 456;', 'value = 125; other = 459;', 'cpp', options(true, true))[0];
  assert.deepEqual(highlightedText(row.left, row.leftChanges), ['3', '6']);
  assert.deepEqual(highlightedText(row.right, row.rightChanges), ['5', '9']);
  assert.equal(row.leftChanges[0].startColumn, 11);
});

test('inline insertions and deletions highlight the existing side at original columns', () => {
  const added = compareFileText('foo(1, 2);', 'foo(10, 20);', 'cpp', options(true, true))[0];
  assert.equal(added.leftChanges.length, 0);
  assert.deepEqual(highlightedText(added.right, added.rightChanges), ['0', '0']);
  const removed = compareFileText('foo(10, 20);', 'foo(1, 2);', 'cpp', options(true, true))[0];
  assert.deepEqual(highlightedText(removed.left, removed.leftChanges), ['0', '0']);
  assert.equal(removed.rightChanges.length, 0);
});

test('inline highlights skip ignored comments and whitespace and retain exact source columns', () => {
  const row = compareFileText('ab/* longer comment */cd = 1; // old', 'ab/* x */cd  = 2; // new', 'cpp', options(false, false))[0];
  assert.deepEqual(highlightedText(row.left, row.leftChanges), ['1']);
  assert.deepEqual(highlightedText(row.right, row.rightChanges), ['2']);
  assert.equal(row.leftChanges[0].startColumn, row.left.text.indexOf('1') + 1);
  const multiline = compareFileText('/* old\n text */foo(1);', '/* new\n other */foo(2);', 'cpp', options(false, false)).find(row => row.changed);
  assert.deepEqual(highlightedText(multiline.left, multiline.leftChanges), ['1']);
  assert.deepEqual(highlightedText(multiline.right, multiline.rightChanges), ['2']);
  const whitespace = compareFileText('a = 1;', 'a  = 1;', 'cpp', options(true, true))[0];
  assert.equal(whitespace.leftChanges.length, 0);
  assert.deepEqual(highlightedText(whitespace.right, whitespace.rightChanges), [' ']);
});

test('inline ranges preserve Unicode surrogate pairs and work on one-sided lines', () => {
  const row = compareFileText('name = "😀";', 'name = "😎";', 'ts', options(true, true))[0];
  assert.deepEqual(highlightedText(row.left, row.leftChanges), ['😀']);
  assert.deepEqual(highlightedText(row.right, row.rightChanges), ['😎']);
  const inserted = compareFileText('a();', 'a();\n  b(); // added', 'cpp', options(false, false)).find(row => row.changed);
  assert.equal(inserted.leftChanges.length, 0);
  assert.deepEqual(highlightedText(inserted.right, inserted.rightChanges), ['b();']);
});

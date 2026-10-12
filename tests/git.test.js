const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { buildSync } = require('esbuild');

function load(source, overrides = {}) {
  const { outputFiles } = buildSync({
    entryPoints: [source], bundle: true, write: false,
    platform: 'node', format: 'cjs', external: ['vscode'],
  });
  const module = { exports: {} };
  vm.runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, Buffer, console,
    require: (name) => overrides[name] ?? require(name),
  });
  return module.exports;
}

const gitApi = load('src/git.ts');
const { compareFolders } = load('src/compare.ts');

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function repository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-compare-test-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'commit.gpgsign', 'false');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return repo;
}

function commit(repo, subject) {
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', subject);
  return git(repo, 'rev-parse', 'HEAD');
}

test('commit snapshots compare added, removed and modified files without changing the working tree', async (t) => {
  const repo = repository(t);
  fs.writeFileSync(path.join(repo, 'modified.txt'), 'old content');
  fs.writeFileSync(path.join(repo, 'removed.txt'), 'removed');
  fs.writeFileSync(path.join(repo, 'same.txt'), 'same');
  const older = commit(repo, 'older');
  fs.writeFileSync(path.join(repo, 'modified.txt'), 'new content');
  fs.unlinkSync(path.join(repo, 'removed.txt'));
  fs.writeFileSync(path.join(repo, 'added.txt'), 'added');
  const newer = commit(repo, 'newer');
  fs.writeFileSync(path.join(repo, 'modified.txt'), 'uncommitted');
  const status = git(repo, 'status', '--porcelain');
  t.after(() => gitApi.cleanupExtractedDirs());

  const [left, right] = await Promise.all([
    gitApi.extractCommit(repo, older, older.slice(0, 7)),
    gitApi.extractCommit(repo, newer, newer.slice(0, 7)),
  ]);
  const tree = await compareFolders(left, right, []);
  assert.deepEqual(Object.fromEntries(tree.map((node) => [node.name, node.status])), {
    'added.txt': 'onlyRight', 'modified.txt': 'modified',
    'removed.txt': 'onlyLeft', 'same.txt': 'same',
  });
  assert.equal(git(repo, 'rev-parse', 'HEAD'), newer);
  assert.equal(git(repo, 'status', '--porcelain'), status);
  assert.equal(fs.readFileSync(path.join(repo, 'modified.txt'), 'utf8'), 'uncommitted');

  // Reusing a short hash must preserve the snapshot of an already open comparison.
  const again = await gitApi.extractCommit(repo, newer, older.slice(0, 7));
  assert.notEqual(again, left);
  assert.equal(fs.readFileSync(path.join(left, 'modified.txt'), 'utf8'), 'old content');
  gitApi.cleanupExtractedDirs();
  for (const dir of [left, right, again]) assert.equal(fs.existsSync(dir), false);
});

test('history includes other branches and detached HEAD; invalid commits fail extraction', async (t) => {
  const repo = repository(t);
  fs.writeFileSync(path.join(repo, 'file.txt'), 'base');
  const base = commit(repo, 'base');
  git(repo, 'checkout', '-qb', 'other');
  fs.writeFileSync(path.join(repo, 'file.txt'), 'other');
  const other = commit(repo, 'other');
  git(repo, 'checkout', '-q', '--detach', base);
  fs.writeFileSync(path.join(repo, 'file.txt'), 'detached');
  const detached = commit(repo, 'detached');
  const commits = await gitApi.getCommits(repo);
  assert.deepEqual(new Set(commits.map((item) => item.hash)), new Set([base, other, detached]));
  t.after(() => gitApi.cleanupExtractedDirs());
  await assert.rejects(gitApi.extractCommit(repo, 'invalid-commit', 'invalid'));
});

test('one Explorer folder opens its own Git history without prompting for another repository', async (t) => {
  const repo = repository(t);
  const commands = new Map();
  const titles = [];
  let dialogs = 0;
  const uri = (fsPath) => ({ fsPath });
  const vscode = {
    commands: { registerCommand: (id, handler) => { commands.set(id, handler); return {}; } },
    workspace: { fs: { stat: async () => ({ type: 2 }) } },
    FileType: { Directory: 2 }, ViewColumn: { Active: 1 },
    Uri: { joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
    window: {
      showOpenDialog: async () => { dialogs++; return undefined; },
      createWebviewPanel: (_id, title) => {
        titles.push(title);
        return { webview: { asWebviewUri: (value) => value.fsPath, onDidReceiveMessage: () => {} } };
      },
    },
  };
  const extension = load('src/extension.ts', { vscode });
  extension.activate({ subscriptions: [], extensionUri: uri(process.cwd()) });
  await commands.get('batchCompare.gitCompare')(uri(repo));
  assert.equal(dialogs, 0);
  assert.deepEqual(titles, ['Git History: repo']);
  const manifest = require('../package.json');
  assert.ok(manifest.contributes.menus['explorer/context'].some((item) => item.command === 'batchCompare.gitCompare'));
});

const assert = require('node:assert/strict');
const vm = require('node:vm');
const { test } = require('node:test');
const { build } = require('esbuild');

test('Comment ON/OFF replaces highlights on repeated results even though Monaco language registration returns void', async () => {
  const listeners = {}, elements = new Map(), highlights = [[], []];
  const element = id => {
    if (!elements.has(id)) elements.set(id, { textContent: '',
      classList: { toggle() {}, contains() { return false; } }, setAttribute() {},
      addEventListener: (event, callback) => { listeners[`${id}:${event}`] = callback; },
    });
    return elements.get(id);
  };
  let created = 0, disposedProviders = 0;
  const registered = [];
  const editorApi = {
    create: () => {
      const i = created++;
      return {
        onDidScrollChange() {}, setScrollPosition() {}, setPosition() {}, revealLineInCenter() {},
        createDecorationsCollection: () => ({ set: value => { highlights[i] = value; }, clear: () => { highlights[i] = []; } }),
        saveViewState: () => ({}), restoreViewState() {}, setModel() {}, updateOptions() {}, dispose() {}, render() {},
        changeViewZones: callback => callback({ removeZone() {}, addZone: () => 'zone' }),
      };
    },
    defineTheme() {}, setTheme() {}, setModelLanguage() {}, ScrollType: { Immediate: 0 },
    createModel: initial => {
      let value = initial;
      return { getValue: () => value, setValue: next => { value = next; }, updateOptions() {}, dispose() {} };
    },
  };
  const monaco = {
    editor: editorApi,
    languages: {
      register: ({ id }) => { registered.push(id); }, // Monaco's register() returns void.
      setTokensProvider: () => ({ dispose: () => { disposedProviders++; } }),
    },
    Range: class { constructor(line, start, _endLine, end) { this.startLineNumber = line; this.startColumn = start; this.endColumn = end; } },
  };
  const { outputFiles } = await build({ entryPoints: ['media/file.js'], bundle: true, write: false,
    platform: 'node', format: 'cjs', define: { __EDITOR_WORKER_SOURCE__: '""' },
    plugins: [{ name: 'mock-monaco-editor', setup(build) {
      build.onResolve({ filter: /^monaco-editor\/(editor|features)\// }, args => ({ path: args.path, namespace: 'mock' }));
      build.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: args.path.endsWith('editor.api.js')
        ? 'export const editor = globalThis.mockMonaco.editor; export const languages = globalThis.mockMonaco.languages; export const Range = globalThis.mockMonaco.Range;'
        : '' }));
    } }],
  });
  const sent = [];
  vm.runInNewContext(outputFiles[0].text, {
    mockMonaco: monaco, self: {},
    document: { body: element('body'), getElementById: element, createElement: () => ({}) },
    window: { addEventListener: (type, callback) => { listeners[type] = callback; } },
    getComputedStyle: () => ({ getPropertyValue: () => 'rgba(121, 121, 121, 0.4)' }),
    MutationObserver: class { observe() {} }, URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    Blob: class {}, Worker: class {}, acquireVsCodeApi: () => ({ postMessage: message => sent.push(message) }),
  });
  const result = (includeComments, changed) => ({ data: {
    type: 'result', options: { includeWhitespace: false, includeComments },
    texts: ['/* 125 */', '/* 123 */'], left: '/left.hpp', right: '/right.hpp',
    rows: [{ left: { number: 1, text: '/* 125 */' }, right: { number: 1, text: '/* 123 */' }, changed }],
  } });
  listeners.message(result(true, true));
  assert.equal(highlights[0].length, 1);
  assert.equal(highlights[1].length, 1);
  listeners['comment:click']();
  assert.equal(highlights[0].length, 0);
  assert.equal(sent.at(-1).option, 'comment');
  listeners.message(result(false, false));
  assert.equal(highlights[0].length, 0);
  assert.equal(highlights[1].length, 0);
  assert.equal(element('status').textContent, 'No differences with current options');
  listeners.message(result(true, true));
  assert.equal(highlights[0].length, 1);
  assert.equal(highlights[1].length, 1);
  assert.equal(registered.length, 2);
  assert.equal(disposedProviders, 4);
  const inline = result(true, true);
  inline.data.rows[0].leftChanges = [{ startColumn: 6, endColumn: 7 }];
  inline.data.rows[0].rightChanges = [{ startColumn: 6, endColumn: 7 }];
  listeners.message(inline);
  assert.equal(highlights[0].length, 2);
  assert.equal(highlights[0][1].options.inlineClassName, 'diff-text-left');
  assert.equal(highlights[0][1].range.startColumn, 6);
  assert.equal(highlights[1][1].options.inlineClassName, 'diff-text-right');
});

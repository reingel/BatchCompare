const assert = require('node:assert/strict');
const vm = require('node:vm');
const { test } = require('node:test');
const { build } = require('esbuild');

test('Comment ON/OFF replaces highlights on repeated results even though Monaco language registration returns void', async () => {
  const listeners = {}, elements = new Map(), highlights = [[], []];
  const element = id => {
    if (!elements.has(id)) elements.set(id, { textContent: '',
      classList: { toggle(name, enabled) { this[name] = enabled; }, contains() { return false; } }, setAttribute() {}, removeAttribute(name) { delete this[name]; },
      addEventListener: (event, callback) => { listeners[`${id}:${event}`] = callback; },
    });
    return elements.get(id);
  };
  let created = 0, disposedProviders = 0;
  const registered = [], editorOptions = [], focusedEditors = [];
  const editorApi = {
    create: (_element, options) => {
      editorOptions.push(options);
      const i = created++;
      return {
        onDidScrollChange() {}, setScrollPosition() {}, focus: () => { focusedEditors.push(i); }, setPosition() {}, revealLineInCenter() {},
        createDecorationsCollection: () => ({ set: value => { highlights[i] = value; }, clear: () => { highlights[i] = []; } }),
        saveViewState: () => ({}), restoreViewState() {}, setModel() {}, updateOptions() {}, dispose() {}, render() {},
        changeViewZones: callback => callback({ removeZone() {}, addZone: () => 'zone' }),
      };
    },
    defineTheme() {}, setTheme() {}, setModelLanguage() {}, ScrollType: { Immediate: 0 },
    MinimapPosition: { Inline: 1, Gutter: 2 }, OverviewRulerLane: { Left: 1, Right: 4 },
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
    Range: class { constructor(line, start, _endLine, end) { this.startLineNumber = line; this.endLineNumber = _endLine; this.startColumn = start; this.endColumn = end; } },
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
    mockMonaco: monaco, self: {}, navigator: { platform: 'MacIntel' }, requestAnimationFrame: callback => callback(),
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
  assert.equal(editorOptions[0].minimap.enabled, false);
  assert.equal(editorOptions[0].overviewRulerLanes, 0);
  assert.equal(editorOptions[1].minimap.enabled, false);
  assert.equal(editorOptions[1].scrollbar.verticalScrollbarSize, 40);
  assert.equal(editorOptions[1].overviewRulerLanes, 3);
  await listeners.message({ data: { type: 'progress', seq: 1, stage: 'Comparing lines', completed: 200, total: 1000 } });
  assert.equal(element('loading-text').textContent, 'Comparing lines… 200 / 1,000 lines');
  assert.equal(element('loading-progress').value, 200);
  assert.equal(element('reload').disabled, true);
  await listeners.message({ data: { type: 'progress', seq: 0, stage: 'stale' } });
  assert.equal(element('loading-progress').value, 200);
  await listeners.message(result(true, true));
  assert.equal(element('loading-overlay').classList.hidden, true);
  assert.equal(element('reload').disabled, false);
  assert.equal(highlights[0].length, 1);
  assert.equal(highlights[1].length, 2);
  assert.equal(highlights[0][0].options.overviewRuler.color.id, 'editorOverviewRuler.deletedForeground');
  assert.equal(highlights[1][0].options.overviewRuler.color.id, 'editorOverviewRuler.addedForeground');
  assert.equal(highlights[1][0].options.overviewRuler.position, 4);
  assert.equal(highlights[1][1].options.overviewRuler.position, 1);
  assert.equal(highlights[1][1].options.overviewRuler.color.id, 'editorOverviewRuler.deletedForeground');
  listeners['comment:click']();
  assert.equal(highlights[0].length, 0);
  assert.equal(sent.at(-1).option, 'comment');
  await listeners.message(result(false, false));
  assert.equal(highlights[0].length, 0);
  assert.equal(highlights[1].length, 0);
  assert.equal(element('status').textContent, 'No differences with current options');
  await listeners.message(result(true, true));
  assert.equal(highlights[0].length, 1);
  assert.equal(highlights[1].length, 2);
  assert.equal(registered.length, 2);
  assert.equal(disposedProviders, 4);
  assert.equal(element('next').title, 'Next difference (⌥↓)');
  let prevented = 0;
  const key = (code, extra = {}) => listeners.keydown({ key: code, altKey: true, ...extra,
    preventDefault: () => prevented++, stopPropagation() {} });
  key('ArrowDown');
  assert.equal(element('status').textContent, 'Difference 1 of 1');
  key('ArrowUp', { shiftKey: true });
  assert.equal(prevented, 1);
  element('status').textContent = '';
  key('ArrowUp');
  assert.equal(element('status').textContent, 'Difference 1 of 1');
  assert.equal(prevented, 2);
  element('status').textContent = '';
  await listeners.message({ data: { type: 'navigate', direction: 1 } });
  assert.equal(element('status').textContent, 'Difference 1 of 1');
  assert.deepEqual([...focusedEditors], [1]);
  const inline = result(true, true);
  inline.data.rows[0].leftChanges = [{ startColumn: 6, endColumn: 7 }];
  inline.data.rows[0].rightChanges = [{ startColumn: 6, endColumn: 7 }];
  await listeners.message(inline);
  assert.equal(highlights[0].length, 2);
  assert.equal(highlights[0][1].options.inlineClassName, 'diff-text-left');
  assert.equal(highlights[0][1].range.startColumn, 6);
  assert.equal(highlights[1][1].options.inlineClassName, 'diff-text-right');
  const inserted = result(true, true);
  inserted.data.rows = [{ right: { number: 1 }, changed: true }];
  await listeners.message(inserted);
  assert.equal(highlights[0][0].options.overviewRuler.color.id, 'editorOverviewRuler.addedForeground');
  assert.equal(highlights[0][0].range.startLineNumber, 1);
  const deleted = result(true, true);
  deleted.data.rows = [{ left: { number: 1 }, changed: true }];
  await listeners.message(deleted);
  assert.equal(highlights[1][0].options.overviewRuler.color.id, 'editorOverviewRuler.deletedForeground');
  const large = result(true, true);
  large.data.largeFile = true;
  large.data.rows = Array.from({ length: 20000 }, (_, i) => ({ left: { number: i + 1 }, right: { number: i + 1 }, changed: true }));
  await listeners.message(large);
  assert.equal(highlights[0].length, 1);
  assert.equal(highlights[1].length, 2);
  assert.equal(highlights[0][0].range.endLineNumber, 20000);
  assert.match(element('performance-note').textContent, /syntax colors disabled/);
  await listeners.message({ data: { type: 'progress', seq: 2, stage: 'Reading files' } });
  assert.equal(element('loading-overlay').classList.hidden, false);
  assert.equal(element('loading-progress').value, undefined);
  await listeners.message({ data: { type: 'error', seq: 2, options: { includeComments: true }, message: 'Read failed' } });
  assert.equal(element('loading-overlay').classList.hidden, true);
  assert.equal(element('reload').disabled, false);
  assert.equal(element('status').textContent, 'Read failed');
});

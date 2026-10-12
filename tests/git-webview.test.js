const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

class Element {
  children = [];
  dataset = {};
  style = {};
  listeners = {};
  disabled = false;
  classList = { add() {}, toggle() {} };
  set textContent(value) { this.text = value; this.children = []; }
  appendChild(child) { this.children.push(child); }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  setAttribute() {}
  querySelectorAll() { return this.children; }
}

function history(repos) {
  const elements = Object.fromEntries(['panels', 'compare-selected', 'selection-hint', 'loading-overlay']
    .map((id) => [id, new Element()]));
  const messages = [];
  let receive;
  vm.runInNewContext(fs.readFileSync('media/git.js', 'utf8'), {
    acquireVsCodeApi: () => ({ postMessage: (message) => messages.push(JSON.parse(JSON.stringify(message))) }),
    window: { addEventListener: (_type, listener) => { receive = listener; } },
    document: {
      getElementById: (id) => elements[id],
      createElement: () => new Element(), createElementNS: () => new Element(),
      addEventListener() {},
    },
  });
  receive({ data: { type: 'init', repos } });
  const rows = (index) => elements.panels.children[index].children[1].children;
  const click = (repo, index, modifiers = {}) => rows(repo)[index].listeners.click(modifiers);
  const compare = () => elements['compare-selected'].listeners.click();
  return { elements, messages, click, compare };
}

function repo(index) {
  return {
    index, repoPath: '/repo' + index,
    commits: ['new', 'middle', 'old'].map((hash) => ({
      hash, shortHash: hash, subject: hash, parents: [],
      graph: { column: 0, color: 0, tracks: [] },
    })),
  };
}

test('Shift+Click nonadjacent commits compares only the endpoints, in history order', () => {
  const view = history([repo(0)]);
  assert.equal(view.elements['compare-selected'].disabled, true);
  view.click(0, 0);
  assert.equal(view.elements['compare-selected'].disabled, true);
  view.click(0, 2, { shiftKey: true });
  assert.equal(view.elements['compare-selected'].disabled, false);
  view.compare();
  assert.deepEqual(view.messages.at(-1), {
    type: 'compare',
    left: { repoIndex: 0, hash: 'old', shortHash: 'old' },
    right: { repoIndex: 0, hash: 'new', shortHash: 'new' },
  });
  view.click(0, 1, { metaKey: true });
  assert.equal(view.elements['compare-selected'].disabled, true);
});

test('one commit per repository enables comparison without modifier keys', () => {
  const view = history([repo(0), repo(1)]);
  view.click(0, 2);
  assert.equal(view.elements['compare-selected'].disabled, true);
  view.click(1, 0);
  assert.equal(view.elements['compare-selected'].disabled, false);
  view.compare();
  assert.deepEqual(view.messages.at(-1), {
    type: 'compare',
    left: { repoIndex: 0, hash: 'old', shortHash: 'old' },
    right: { repoIndex: 1, hash: 'new', shortHash: 'new' },
  });
});

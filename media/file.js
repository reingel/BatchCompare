import * as monaco from 'monaco-editor/editor/editor.api.js';
import { toMonacoColor } from './fileColors';
import 'monaco-editor/editor/browser/coreCommands.js';
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard.js';
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js';
import 'monaco-editor/editor/contrib/find/browser/findController.js';
import 'monaco-editor/features/find/register.js';
import 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js';
import 'monaco-editor/editor/contrib/lineSelection/browser/lineSelection.js';
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js';

const workerURL = URL.createObjectURL(new Blob([__EDITOR_WORKER_SOURCE__], { type: 'text/javascript' }));
self.MonacoEnvironment = { getWorker: () => new Worker(workerURL) };
const vscode = acquireVsCodeApi();
const status = document.getElementById('status');
let sequence = 0, renderVersion = 0;
function showLoading(stage = 'Comparing lines', completed, total) {
  renderVersion++;
  document.getElementById('loading-overlay').classList.toggle('hidden', false);
  document.getElementById('editors').setAttribute('aria-busy', 'true');
  const text = total > 0 ? `${stage}… ${completed.toLocaleString()} / ${total.toLocaleString()} lines` : `${stage}…`;
  document.getElementById('loading-text').textContent = text;
  status.textContent = text;
  const progress = document.getElementById('loading-progress');
  if (total > 0) { progress.max = total; progress.value = completed; }
  else progress.removeAttribute('value');
  for (const id of ['whitespace', 'comment', 'reload', 'previous', 'next']) document.getElementById(id).disabled = true;
}
function hideLoading() {
  document.getElementById('loading-overlay').classList.toggle('hidden', true);
  document.getElementById('editors').setAttribute('aria-busy', 'false');
  for (const id of ['whitespace', 'comment', 'reload']) document.getElementById(id).disabled = false;
}
// Allow the overlay to paint before Monaco creates models and decorations.
const nextPaint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const defaults = {
  readOnly: true, domReadOnly: true, automaticLayout: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  wordWrap: 'off', renderLineHighlight: 'all', glyphMargin: true,
  folding: false, lineNumbersMinChars: 4, lineDecorationsWidth: 8,
  contextmenu: true, overviewRulerLanes: 3, overviewRulerBorder: false, renderWhitespace: 'selection',
  ariaLabel: 'Read-only file comparison', fixedOverflowWidgets: true,
};
const editors = ['left', 'right'].map(side => monaco.editor.create(document.getElementById(`${side}-editor`), {
  ...defaults,
  overviewRulerLanes: side === 'right' ? 3 : 0,
  hideCursorInOverviewRuler: true,
  scrollbar: { vertical: 'visible', verticalScrollbarSize: side === 'right' ? 40 : 14 },
}));
const languageIds = ['batch-source-left', 'batch-source-right'];
languageIds.forEach(id => monaco.languages.register({ id }));
const decorations = editors.map(editor => editor.createDecorationsCollection());
let zones = [[], []], providers = [], models = [], changes = [], selected = -1;
let syncing = false, focused = false;
editors.forEach((editor, i) => editor.onDidScrollChange(event => {
  if (syncing) return;
  syncing = true;
  editors[1 - i].setScrollPosition({ scrollTop: event.scrollTop, scrollLeft: event.scrollLeft });
  syncing = false;
}));
function cssColor(name, fallback) {
  return toMonacoColor(getComputedStyle(document.body).getPropertyValue(`--vscode-${name}`), fallback);
}
let currentSyntax;
function applyTheme(syntax = currentSyntax) {
  currentSyntax = syntax;
  const light = document.body.classList.contains('vscode-light') || document.body.classList.contains('vscode-high-contrast-light');
  const dark = !light;
  const base = document.body.classList.contains('vscode-high-contrast-light') ? 'hc-light'
    : document.body.classList.contains('vscode-high-contrast') ? 'hc-black' : dark ? 'vs-dark' : 'vs';
  const rules = [];
  for (let color = 1; color < (syntax?.colors.length ?? 0); color++) {
    if (!syntax.colors[color]) continue;
    for (let style = 0; style < 16; style++) rules.push({ token: `tm${color}s${style}`,
      foreground: syntax.colors[color].replace('#', ''),
      fontStyle: [style & 1 ? 'italic' : '', style & 2 ? 'bold' : '', style & 4 ? 'underline' : '', style & 8 ? 'strikethrough' : ''].filter(Boolean).join(' '),
    });
  }
  monaco.editor.defineTheme('batch-vscode', { base, inherit: true, rules,
    colors: {
      'editor.background': cssColor('editor-background', dark ? '#1e1e1e' : '#ffffff'),
      'editor.foreground': cssColor('editor-foreground', dark ? '#d4d4d4' : '#333333'),
      'editorLineNumber.foreground': cssColor('editorLineNumber-foreground', '#858585'),
      'editorLineNumber.activeForeground': cssColor('editorLineNumber-activeForeground', dark ? '#c6c6c6' : '#333333'),
      'editor.selectionBackground': cssColor('editor-selectionBackground', dark ? '#264f78' : '#add6ff'),
      'editor.inactiveSelectionBackground': cssColor('editor-inactiveSelectionBackground', dark ? '#3a3d41' : '#e5ebf1'),
      'editorCursor.foreground': cssColor('editorCursor-foreground', dark ? '#aeafad' : '#000000'),
      'editorWhitespace.foreground': cssColor('editorWhitespace-foreground', '#80808080'),
      'editor.findMatchBackground': cssColor('editor-findMatchBackground', '#515c6a'),
      'editor.findMatchHighlightBackground': cssColor('editor-findMatchHighlightBackground', '#ea5c0055'),
      'editorGutter.background': cssColor('editorGutter-background', dark ? '#1e1e1e' : '#ffffff'),
      'scrollbarSlider.background': cssColor('scrollbarSlider-background', '#79797966'),
      'scrollbarSlider.hoverBackground': cssColor('scrollbarSlider-hoverBackground', '#646464b3'),
      'scrollbarSlider.activeBackground': cssColor('scrollbarSlider-activeBackground', '#bfbfbf66'),
      'scrollbar.shadow': cssColor('scrollbar-shadow', '#000000'),
      'editorOverviewRuler.addedForeground': cssColor('editorOverviewRuler-addedForeground', '#369432'),
      'editorOverviewRuler.deletedForeground': cssColor('editorOverviewRuler-deletedForeground', '#f14c4c'),
    },
  });
  monaco.editor.setTheme('batch-vscode');
}
new MutationObserver(() => applyTheme()).observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
applyTheme();
class LineState {
  constructor(line = 0) { this.line = line; }
  clone() { return new LineState(this.line); }
  equals(other) { return other instanceof LineState && other.line === this.line; }
}
function setSource(texts, syntax) {
  providers.forEach(provider => provider.dispose()); providers = [];
  editors.forEach((editor, i) => {
    const state = editor.saveViewState();
    const language = languageIds[i];
    const tokens = syntax?.tokens[i];
    providers.push(monaco.languages.setTokensProvider(language, {
      getInitialState: () => new LineState(),
      tokenize: (_line, state) => {
        const encoded = tokens?.[state.line] ?? [0, 0];
        const result = [];
        for (let j = 0; j < encoded.length; j += 2) {
          const metadata = encoded[j + 1];
          result.push({ startIndex: encoded[j], scopes: `tm${(metadata >>> 15) & 511}s${(metadata >>> 11) & 15}` });
        }
        return { tokens: result, endState: new LineState(state.line + 1) };
      },
    }));
    if (!models[i]) { models[i] = monaco.editor.createModel(texts[i], language); editor.setModel(models[i]); }
    else {
      if (models[i].getValue() !== texts[i]) models[i].setValue(texts[i]);
      monaco.editor.setModelLanguage(models[i], language);
    }
    if (syntax?.editor) editor.updateOptions({ fontFamily: syntax.editor.fontFamily, fontSize: syntax.editor.fontSize,
      fontWeight: syntax.editor.fontWeight, fontLigatures: syntax.editor.fontLigatures,
      renderWhitespace: syntax.editor.renderWhitespace, lineHeight: syntax.editor.lineHeight ?? 0 });
    models[i].updateOptions({ tabSize: syntax?.editor.tabSize ?? 4 });
    if (state) editor.restoreViewState(state);
  });
}
function diffMarkers(side) {
  const kind = side === 'left' ? 'deleted' : 'added';
  return {
    overviewRuler: { color: { id: `editorOverviewRuler.${kind}Foreground` },
      position: side === 'left' ? monaco.editor.OverviewRulerLane.Left : monaco.editor.OverviewRulerLane.Right },
  };
}
function renderDiff(rows) {
  changes = []; selected = -1;
  let inChange = false;
  for (const row of rows) {
    if (row.changed && !inChange) changes.push(row);
    inChange = row.changed;
  }
  editors.forEach((editor, i) => {
    const side = i === 0 ? 'left' : 'right';
    const highlights = [];
    let block;
    let previous = 0, missing = 0, missingChanged = false;
    editor.changeViewZones(accessor => {
      zones[i].forEach(zone => accessor.removeZone(zone)); zones[i] = [];
      const flush = () => {
        if (!missing) return;
        const node = document.createElement('div'); node.className = 'alignment-zone';
        zones[i].push(accessor.addZone({ afterLineNumber: previous, heightInLines: missing, domNode: node }));
        // Mark insertions/deletions even on the pane that only has an alignment gap.
        if (missingChanged) highlights.push({ range: new monaco.Range(Math.max(1, previous), 1, Math.max(1, previous), 1),
          options: diffMarkers(i === 0 ? 'right' : 'left') });
        missing = 0; missingChanged = false;
      };
      for (const row of rows) {
        const line = row[side];
        if (!line) { missing++; missingChanged ||= row.changed; continue; }
        flush(); previous = line.number;
        if (row.changed) {
          if (block && block.range.endLineNumber + 1 === line.number) block.range.endLineNumber = line.number;
          else {
            block = { range: new monaco.Range(line.number, 1, line.number, 1000000000), options: {
              isWholeLine: true, className: `diff-${side}`, glyphMarginClassName: `diff-glyph-${side}`,
              ...diffMarkers(side),
            } };
            highlights.push(block);
          }
        } else block = undefined;
        for (const range of row[`${side}Changes`] ?? []) highlights.push({
          range: new monaco.Range(line.number, range.startColumn, line.number, range.endColumn),
          options: { inlineClassName: `diff-text-${side}`, inlineClassNameAffectsLetterSpacing: false },
        });
      }
      flush();
    });
    if (side === 'right') {
      // Project left-side replacements onto the single right-side overview.
      let removed;
      for (const row of rows) {
        if (!row.changed || !row.left || !row.right) { removed = undefined; continue; }
        const number = row.right.number;
        if (removed && removed.range.endLineNumber + 1 === number) removed.range.endLineNumber = number;
        else {
          removed = { range: new monaco.Range(number, 1, number, 1000000000), options: diffMarkers('left') };
          highlights.push(removed);
        }
      }
    }
    decorations[i].set(highlights);
    editor.render(true);
  });
  for (const id of ['previous', 'next']) document.getElementById(id).disabled = !changes.length;
  status.textContent = changes.length ? `${changes.length} differences` : 'No differences with current options';
}
function navigate(direction) {
  if (!changes.length) return;
  selected = selected < 0 ? (direction > 0 ? 0 : changes.length - 1) : (selected + direction + changes.length) % changes.length;
  const row = changes[selected];
  const side = row.left ? 0 : 1;
  const line = (row.left ?? row.right).number;
  editors[side].revealLineInCenter(line, monaco.editor.ScrollType.Immediate);
  editors[side].setPosition({ lineNumber: line, column: 1 });
  status.textContent = `Difference ${selected + 1} of ${changes.length}`;
}
for (const option of ['whitespace', 'comment']) document.getElementById(option).addEventListener('click', () => {
  decorations.forEach(decoration => decoration.clear());
  editors.forEach(editor => editor.render(true));
  changes = []; selected = -1;
  for (const id of ['previous', 'next']) document.getElementById(id).disabled = true;
  showLoading(); vscode.postMessage({ type: 'toggle', option });
});
document.getElementById('reload').addEventListener('click', () => { showLoading('Reading files'); vscode.postMessage({ type: 'reload' }); });
document.getElementById('original').addEventListener('click', () => vscode.postMessage({ type: 'original' }));
document.getElementById('previous').addEventListener('click', () => navigate(-1));
document.getElementById('next').addEventListener('click', () => navigate(1));
const altKey = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌥' : 'Alt+';
for (const [id, arrow, label] of [['previous', '↑', 'Previous difference'], ['next', '↓', 'Next difference']]) {
  document.getElementById(id).title = `${label} (${altKey}${arrow})`;
}
// Monaco의 Alt+화살표(줄 이동)보다 먼저 받도록 capture 단계에서 처리한다.
window.addEventListener('keydown', event => {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  event.preventDefault(); event.stopPropagation();
  const button = document.getElementById(event.key === 'ArrowUp' ? 'previous' : 'next');
  if (!button.disabled) navigate(event.key === 'ArrowUp' ? -1 : 1);
}, true);
window.addEventListener('message', async ({ data: message }) => {
  if (message.type === 'navigate') {
    if (!document.getElementById(message.direction < 0 ? 'previous' : 'next').disabled) navigate(message.direction);
    return;
  }
  if (!['progress', 'result', 'error'].includes(message.type)) return;
  if (message.seq !== undefined) {
    if (message.seq < sequence) return;
    sequence = message.seq;
  }
  if (message.type === 'progress') {
    showLoading(message.stage, message.completed, message.total);
    return;
  }
  for (const [id, enabled] of [['whitespace', message.options.includeWhitespace], ['comment', message.options.includeComments]]) {
    const button = document.getElementById(id);
    button.textContent = `${id === 'comment' ? 'Comment' : 'Whitespace'}: ${enabled ? 'ON' : 'OFF'}`;
    button.classList.toggle('active', enabled); button.setAttribute('aria-pressed', String(enabled));
  }
  if (message.type === 'error') {
    renderVersion++;
    hideLoading();
    document.getElementById('performance-note').textContent = '';
    status.textContent = message.message;
    changes = []; decorations.forEach(decoration => decoration.clear());
    for (const id of ['previous', 'next']) document.getElementById(id).disabled = true;
    return;
  }
  showLoading('Displaying comparison');
  const version = renderVersion;
  await nextPaint();
  if (version !== renderVersion) return;
  try {
    document.getElementById('left-name').textContent = message.left;
    document.getElementById('right-name').textContent = message.right;
    ['left', 'right'].forEach((side, i) => {
      const element = document.getElementById(`${side}-encoding`);
      element.textContent = message.encodings?.[i] ?? '';
      element.title = message.encodings?.[i] ? `Detected encoding: ${message.encodings[i]}` : '';
    });
    document.getElementById('performance-note').textContent = message.largeFile ? 'Large file: syntax colors disabled for speed' : '';
    applyTheme(message.syntax); setSource(message.texts, message.syntax); renderDiff(message.rows);
    // 창이 열리자마자 webview 안의 단축키가 동작하도록 처음 표시할 때 오른쪽 에디터에 포커스를 둔다.
    if (!focused) { focused = true; editors[1].focus(); }
  } catch (error) {
    status.textContent = `Unable to display comparison: ${error.message}`;
  } finally { hideLoading(); }
});
window.addEventListener('unload', () => {
  providers.forEach(provider => provider.dispose()); editors.forEach(editor => editor.dispose());
  models.forEach(model => model.dispose()); URL.revokeObjectURL(workerURL);
});
showLoading('Reading files'); vscode.postMessage({ type: 'ready' });

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
const defaults = {
  readOnly: true, domReadOnly: true, automaticLayout: true,
  minimap: { enabled: false }, scrollBeyondLastLine: false,
  wordWrap: 'off', renderLineHighlight: 'all', glyphMargin: true,
  folding: false, lineNumbersMinChars: 4, lineDecorationsWidth: 8,
  contextmenu: true, overviewRulerLanes: 0, overviewRulerBorder: false, renderWhitespace: 'selection',
  ariaLabel: 'Read-only file comparison', fixedOverflowWidgets: true,
};
const editors = ['left', 'right'].map(side => monaco.editor.create(document.getElementById(`${side}-editor`), defaults));
const languageIds = ['batch-source-left', 'batch-source-right'];
languageIds.forEach(id => monaco.languages.register({ id }));
const decorations = editors.map(editor => editor.createDecorationsCollection());
let zones = [[], []], providers = [], models = [], changes = [], selected = -1;
let syncing = false;
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
    let previous = 0, missing = 0;
    editor.changeViewZones(accessor => {
      zones[i].forEach(zone => accessor.removeZone(zone)); zones[i] = [];
      const flush = () => {
        if (!missing) return;
        const node = document.createElement('div'); node.className = 'alignment-zone';
        zones[i].push(accessor.addZone({ afterLineNumber: previous, heightInLines: missing, domNode: node }));
        missing = 0;
      };
      for (const row of rows) {
        const line = row[side];
        if (!line) { missing++; continue; }
        flush(); previous = line.number;
        if (row.changed) highlights.push({ range: new monaco.Range(line.number, 1, line.number, 1), options: {
          isWholeLine: true, className: `diff-${side}`, glyphMarginClassName: `diff-glyph-${side}`,
        } });
        for (const range of row[`${side}Changes`] ?? []) highlights.push({
          range: new monaco.Range(line.number, range.startColumn, line.number, range.endColumn),
          options: { inlineClassName: `diff-text-${side}`, inlineClassNameAffectsLetterSpacing: false },
        });
      }
      flush();
    });
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
  status.textContent = 'Comparing…'; vscode.postMessage({ type: 'toggle', option });
});
document.getElementById('reload').addEventListener('click', () => { status.textContent = 'Comparing…'; vscode.postMessage({ type: 'reload' }); });
document.getElementById('original').addEventListener('click', () => vscode.postMessage({ type: 'original' }));
document.getElementById('previous').addEventListener('click', () => navigate(-1));
document.getElementById('next').addEventListener('click', () => navigate(1));
window.addEventListener('message', ({ data: message }) => {
  if (!['result', 'error'].includes(message.type)) return;
  for (const [id, enabled] of [['whitespace', message.options.includeWhitespace], ['comment', message.options.includeComments]]) {
    const button = document.getElementById(id);
    button.textContent = `${id === 'comment' ? 'Comment' : 'Whitespace'}: ${enabled ? 'ON' : 'OFF'}`;
    button.classList.toggle('active', enabled); button.setAttribute('aria-pressed', String(enabled));
  }
  if (message.type === 'error') {
    status.textContent = message.message;
    changes = []; decorations.forEach(decoration => decoration.clear());
    for (const id of ['previous', 'next']) document.getElementById(id).disabled = true;
    return;
  }
  document.getElementById('left-name').textContent = message.left;
  document.getElementById('right-name').textContent = message.right;
  applyTheme(message.syntax); setSource(message.texts, message.syntax); renderDiff(message.rows);
});
window.addEventListener('unload', () => {
  providers.forEach(provider => provider.dispose()); editors.forEach(editor => editor.dispose());
  models.forEach(model => model.dispose()); URL.revokeObjectURL(workerURL);
});
status.textContent = 'Comparing…'; vscode.postMessage({ type: 'ready' });

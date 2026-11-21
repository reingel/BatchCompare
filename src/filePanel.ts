import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { CompareOptions, DEFAULT_COMPARE_OPTIONS, isBinary } from './compare';
import { detectAndDecode, editorEncodingLabel } from './encoding';
import { compareFileTextAsync } from './fileDiff';
import { getFileSyntax } from './fileSyntax';
import { compactRows, MAX_FILE_BYTES, MAX_FILE_LINES, RenderRow, startFileComparison } from './fileComparison';

const filePanels = new Set<vscode.WebviewPanel>();

export function navigateActiveFilePanel(direction: 1 | -1): void {
  const panel = [...filePanels].find(item => item.active);
  void panel?.webview.postMessage({ type: 'navigate', direction });
}

export function createFileComparePanel(
  context: vscode.ExtensionContext, left: vscode.Uri, right: vscode.Uri,
  initialOptions: CompareOptions = DEFAULT_COMPARE_OPTIONS
): void {
  const options = { ...initialOptions };
  const panel = vscode.window.createWebviewPanel('batchCompare.file',
    `${path.basename(left.fsPath)} ↔ ${path.basename(right.fsPath)}`,
    vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
  filePanels.add(panel);
  const nonce = crypto.randomBytes(16).toString('hex');
  const asset = (name: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', name));
  panel.webview.html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource} 'unsafe-inline'; font-src ${panel.webview.cspSource} data:; script-src 'nonce-${nonce}'; worker-src blob:;">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="${asset('file-editor.css')}">
    <link rel="stylesheet" href="${asset('file.css')}"><title>File Compare</title></head><body>
    <nav aria-label="Comparison options">
      <button id="whitespace" title="ON: include whitespace differences; OFF: ignore whitespace differences">Whitespace</button>
      <button id="comment" title="ON: highlight comment differences; OFF: ignore comment differences (always displayed)">Comment</button>
      <span class="nav-group"><button id="previous" class="nav" aria-keyshortcuts="Alt+ArrowUp">↑ Previous</button><button id="next" class="nav" aria-keyshortcuts="Alt+ArrowDown">↓ Next</button></span>
      <button id="original">Open Original Diff</button>
      <span id="status" role="status"></span>
      <span id="performance-note"></span>
      <button id="reload">⟳ Reload</button>
    </nav><header><div id="left-name"></div><div id="right-name"></div></header>
    <main id="editors"><div id="left-editor" aria-label="Left file"></div><div id="right-editor" aria-label="Right file"></div>
    <div id="loading-overlay" role="status" aria-live="polite">
      <div class="loading-spinner" aria-hidden="true"></div>
      <div id="loading-text">Reading files…</div><progress id="loading-progress" aria-label="Comparison progress"></progress>
    </div></main>
    <footer id="statusbar" aria-label="File status"><div id="left-encoding"></div><div id="right-encoding"></div></footer>
    <script nonce="${nonce}" src="${asset('file-editor.js')}"></script></body></html>`;
  let generation = 0;
  let disposed = false;
  let cancelComparison: (() => void) | undefined;
  let cached: { texts: string[]; options: CompareOptions; rows: RenderRow[] } | undefined;
  const refresh = async () => {
    const current = ++generation;
    cancelComparison?.(); cancelComparison = undefined;
    const snapshot = { ...options };
    const report = async (stage: string, completed?: number, total?: number) => {
      if (disposed || current !== generation) throw new Error('Comparison superseded');
      await panel.webview.postMessage({ type: 'progress', seq: current, stage, completed, total });
    };
    const progress = (stage: string) => (completed: number, total: number) => {
      if (disposed || current !== generation) throw new Error('Comparison superseded');
      void panel.webview.postMessage({ type: 'progress', seq: current, stage, completed, total });
    };
    try {
      await report('Reading files');
      // 구문 강조를 위해 openTextDocument로 연 문서는 VS Code 기본 인코딩으로 읽혀 한글이 깨질 수 있으므로,
      // 저장되지 않은 변경이 있는 문서만 편집 중인 내용을 쓰고 나머지는 디스크 바이트를 판별해 쓴다.
      const documents = [left, right].map(uri => vscode.workspace.textDocuments.find(doc => doc.isDirty && doc.uri.toString() === uri.toString()));
      const decoded = await Promise.all([left, right].map((uri, i) => documents[i]
        ? openDocumentText(documents[i]!, uri)
        : vscode.workspace.fs.readFile(uri).then(bytes => ({ buf: Buffer.from(bytes), ...detectAndDecode(Buffer.from(bytes)) }))));
      if (disposed || current !== generation) return;
      const buffers = decoded.map(item => item.buf);
      if (buffers.some(isBinary)) throw new Error('Binary files cannot be shown here. Use Open Original Diff.');
      if (buffers.some(buf => buf.length > MAX_FILE_BYTES)) throw new Error('Files over 20 MB cannot be shown here. Use Open Original Diff.');
      const texts = decoded.map(item => item.text);
      const encodings = decoded.map(item => item.encoding);
      const ext = path.extname(left.fsPath).slice(1).toLowerCase();
      const lineCounts = texts.map(text => text.split(/\r\n?|\n/).length);
      if (lineCounts.some(count => count > MAX_FILE_LINES)) throw new Error('Files over 200,000 lines cannot be shown here. Use Open Original Diff.');
      const largeFile = buffers.some(buf => buf.length > 2 * 1024 * 1024) || lineCounts.some(count => count > 20000);
      await report('Comparing lines');
      await new Promise<void>(resolve => setImmediate(resolve));
      if (disposed || current !== generation) return;
      let rows: RenderRow[];
      if (cached && texts.every((text, i) => text === cached!.texts[i]) &&
        snapshot.includeWhitespace === cached.options.includeWhitespace && snapshot.includeComments === cached.options.includeComments) {
        rows = cached.rows;
      } else if (largeFile) {
        const job = startFileComparison(vscode.Uri.joinPath(context.extensionUri, 'dist', 'fileCompareWorker.js').fsPath,
          texts, ext, snapshot, progress('Comparing lines'));
        cancelComparison = job.cancel;
        try { rows = await job.result; }
        finally { if (cancelComparison === job.cancel) cancelComparison = undefined; }
      } else {
        rows = compactRows(await compareFileTextAsync(texts[0], texts[1], ext, snapshot, progress('Comparing lines')));
      }
      if (disposed || current !== generation) return;
      cached = { texts, options: snapshot, rows };
      await report('Applying syntax highlighting');
      let syntax;
      try { syntax = await getFileSyntax(context, [left, right], texts, progress('Applying syntax highlighting'), !largeFile); } catch { /* plain text remains usable if a grammar fails */ }
      if (disposed || current !== generation) return;
      await report('Displaying comparison');
      if (disposed || current !== generation) return;
      void panel.webview.postMessage({ type: 'result', seq: current, rows, texts, syntax, largeFile, encodings, options: snapshot, left: left.fsPath, right: right.fsPath });
    } catch (error) {
      if (!disposed && current === generation) void panel.webview.postMessage({
        type: 'error', seq: current, options: snapshot, message: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const listener = panel.webview.onDidReceiveMessage(async message => {
    if (message.type === 'ready' || message.type === 'reload') await refresh();
    else if (message.type === 'toggle' && (message.option === 'whitespace' || message.option === 'comment')) {
      if (message.option === 'whitespace') options.includeWhitespace = !options.includeWhitespace;
      else options.includeComments = !options.includeComments;
      await refresh();
    } else if (message.type === 'original') await vscode.commands.executeCommand('vscode.diff', left, right);
  });
  const themeListener = vscode.window.onDidChangeActiveColorTheme?.(() => void refresh());
  const configListener = vscode.workspace.onDidChangeConfiguration?.(event => {
    if (event.affectsConfiguration('editor') || event.affectsConfiguration('workbench.colorTheme') ||
      event.affectsConfiguration('workbench.colorCustomizations')) void refresh();
  });
  panel.onDidDispose(() => {
    filePanels.delete(panel);
    cancelComparison?.(); cached = undefined;
    disposed = true; generation++; listener.dispose(); themeListener?.dispose(); configListener?.dispose();
  });
}

async function openDocumentText(document: vscode.TextDocument, uri: vscode.Uri): Promise<{ buf: Buffer; text: string; encoding: string }> {
  const text = document.getText();
  // TextDocument.encoding은 VS Code 1.100 이후에만 있으므로, 없으면 디스크 바이트로 판별한다.
  const id = (document as { encoding?: string }).encoding;
  let encoding = id ? editorEncodingLabel(id) : 'UTF-8';
  if (!id) {
    try { encoding = detectAndDecode(Buffer.from(await vscode.workspace.fs.readFile(uri))).encoding; } catch { /* 저장되지 않은 문서 */ }
  }
  return { buf: Buffer.from(text, 'utf8'), text, encoding };
}

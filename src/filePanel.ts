import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { CompareOptions, DEFAULT_COMPARE_OPTIONS, isBinary } from './compare';
import { compareFileText } from './fileDiff';
import { getFileSyntax } from './fileSyntax';

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
      <button id="previous">↑ Previous</button><button id="next">↓ Next</button>
      <button id="reload">⟳ Reload</button><button id="original">Open Original Diff</button>
      <span id="status" role="status"></span>
    </nav><header><div id="left-name"></div><div id="right-name"></div></header>
    <main id="editors"><div id="left-editor" aria-label="Left file"></div><div id="right-editor" aria-label="Right file"></div></main>
    <script nonce="${nonce}" src="${asset('file-editor.js')}"></script></body></html>`;
  let generation = 0;
  let disposed = false;
  const refresh = async () => {
    const current = ++generation;
    const snapshot = { ...options };
    try {
      const documents = [left, right].map(uri => vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString()));
      const buffers = await Promise.all([left, right].map((uri, i) => documents[i]
        ? Promise.resolve(Buffer.from(documents[i]!.getText(), 'utf8'))
        : vscode.workspace.fs.readFile(uri).then(bytes => Buffer.from(bytes))));
      if (disposed || current !== generation) return;
      if (buffers.some(isBinary)) throw new Error('Binary files cannot be shown here. Use Open Original Diff.');
      if (buffers.some(buf => buf.length > 2 * 1024 * 1024)) throw new Error('Files over 2 MB cannot be shown here. Use Open Original Diff.');
      const ext = path.extname(left.fsPath).slice(1).toLowerCase();
      const texts = buffers.map(buf => buf.toString('utf8'));
      if (texts.some(text => text.split(/\r\n?|\n/).length > 20000)) throw new Error('Files over 20,000 lines cannot be shown here. Use Open Original Diff.');
      const rows = compareFileText(texts[0], texts[1], ext, snapshot);
      let syntax;
      try { syntax = await getFileSyntax(context, [left, right], texts); } catch { /* plain text remains usable if a grammar fails */ }
      if (disposed || current !== generation) return;
      void panel.webview.postMessage({ type: 'result', rows, texts, syntax, options: snapshot, left: left.fsPath, right: right.fsPath });
    } catch (error) {
      if (!disposed && current === generation) void panel.webview.postMessage({
        type: 'error', options: snapshot, message: error instanceof Error ? error.message : String(error),
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
    disposed = true; generation++; listener.dispose(); themeListener?.dispose(); configListener?.dispose();
  });
}

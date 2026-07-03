import * as path from 'path';
import * as vscode from 'vscode';
import { compareFolders, DiffNode } from './compare';

interface WebviewMessage {
  type: 'ready' | 'reload' | 'openDiff' | 'openFile' | 'changeRoot' | 'swap';
  relPath?: string;
  side?: 'left' | 'right';
}

function getExclude(): string[] {
  return vscode.workspace
    .getConfiguration('folderCompare')
    .get<string[]>('exclude', []);
}

export function createComparePanel(
  context: vscode.ExtensionContext,
  initialLeftRoot: vscode.Uri,
  initialRightRoot: vscode.Uri,
  tree: DiffNode[]
): void {
  let leftRoot = initialLeftRoot;
  let rightRoot = initialRightRoot;

  const panel = vscode.window.createWebviewPanel(
    'folderCompare',
    `${path.basename(leftRoot.fsPath)} ↔ ${path.basename(rightRoot.fsPath)}`,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    }
  );

  const scriptUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, 'media', 'main.js')
  );
  const styleUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, 'media', 'main.css')
  );
  const nonce = getNonce();

  panel.webview.html = getHtml(panel.webview, scriptUri, styleUri, nonce);

  const refresh = async () => {
    const fresh = await compareFolders(
      leftRoot.fsPath,
      rightRoot.fsPath,
      getExclude()
    );
    panel.title = `${path.basename(leftRoot.fsPath)} ↔ ${path.basename(rightRoot.fsPath)}`;
    panel.webview.postMessage({
      type: 'init',
      tree: fresh,
      leftName: leftRoot.fsPath,
      rightName: rightRoot.fsPath,
    });
  };

  panel.webview.onDidReceiveMessage(
    async (message: WebviewMessage) => {
      if (message.type === 'ready') {
        panel.webview.postMessage({
          type: 'init',
          tree,
          leftName: leftRoot.fsPath,
          rightName: rightRoot.fsPath,
        });
        return;
      }
      if (message.type === 'reload') {
        await refresh();
        return;
      }
      if (message.type === 'swap') {
        [leftRoot, rightRoot] = [rightRoot, leftRoot];
        await refresh();
        return;
      }
      if (message.type === 'changeRoot') {
        const side = message.side;
        if (side !== 'left' && side !== 'right') {
          return;
        }
        const current = side === 'left' ? leftRoot : rightRoot;
        const picked = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          defaultUri: current,
          openLabel: `Select ${side === 'left' ? 'Left' : 'Right'} Folder`,
          title: `Select the ${side} folder to compare`,
        });
        if (!picked || picked.length === 0) {
          return;
        }
        if (side === 'left') {
          leftRoot = picked[0];
        } else {
          rightRoot = picked[0];
        }
        await refresh();
        return;
      }
      if (!message.relPath) {
        return;
      }
      const leftUri = vscode.Uri.joinPath(leftRoot, ...message.relPath.split('/'));
      const rightUri = vscode.Uri.joinPath(rightRoot, ...message.relPath.split('/'));
      if (message.type === 'openDiff') {
        await vscode.commands.executeCommand(
          'vscode.diff',
          leftUri,
          rightUri,
          `${message.relPath} (${path.basename(leftRoot.fsPath)} ↔ ${path.basename(rightRoot.fsPath)})`
        );
      } else if (message.type === 'openFile') {
        await vscode.commands.executeCommand(
          'vscode.open',
          message.side === 'left' ? leftUri : rightUri
        );
      }
    },
    undefined,
    context.subscriptions
  );
}

function getHtml(
  webview: vscode.Webview,
  scriptUri: vscode.Uri,
  styleUri: vscode.Uri,
  nonce: string
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
  <title>Folder Compare</title>
</head>
<body>
  <div id="top">
    <div id="toolbar">
      <button id="swap" title="Swap left and right folders">⇄ Swap</button>
      <button id="expand-diff-only" title="Expand Diff Only">Expand Diff Only</button>
      <button id="expand-all" title="Expand All">Expand All</button>
      <button id="collapse-all" title="Collapse All">Collapse All</button>
      <button id="reload" title="Reload and compare again">⟳ Reload</button>
    </div>
    <div id="header">
      <div id="left-name" class="root-name"></div>
      <div id="right-name" class="root-name"></div>
    </div>
  </div>
  <div id="tree"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CompareOptions, DEFAULT_COMPARE_OPTIONS, compareFolders, DiffNode } from './compare';

interface WebviewMessage {
  type:
    | 'ready'
    | 'reload'
    | 'openDiff'
    | 'openFile'
    | 'changeRoot'
    | 'swap'
    | 'toggleOption'
    | 'copyToRight';
  relPath?: string;
  side?: 'left' | 'right';
  option?: 'whitespace' | 'comment';
}

function getExclude(): string[] {
  return vscode.workspace
    .getConfiguration('batchCompare')
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
  // 초기 tree는 호출측에서 DEFAULT_COMPARE_OPTIONS로 계산되므로 같은 값으로 시작한다.
  const options: CompareOptions = { ...DEFAULT_COMPARE_OPTIONS };

  const panel = vscode.window.createWebviewPanel(
    'batchCompare',
    `${path.basename(leftRoot.fsPath)} ↔ ${path.basename(rightRoot.fsPath)}`,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      // Diff 보기를 열면 이 패널이 같은 편집기 그룹에서 잠시 가려지는데(hidden),
      // 이 옵션이 없으면 vscode가 webview 내용을 폐기했다가 다시 보일 때 처음부터
      // 재로드하여 사용자가 펼치거나 접은 트리 상태가 매번 초기화된다.
      retainContextWhenHidden: true,
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
      getExclude(),
      options
    );
    panel.title = `${path.basename(leftRoot.fsPath)} ↔ ${path.basename(rightRoot.fsPath)}`;
    panel.webview.postMessage({
      type: 'init',
      tree: fresh,
      leftName: leftRoot.fsPath,
      rightName: rightRoot.fsPath,
      options,
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
          options,
        });
        return;
      }
      if (message.type === 'reload') {
        await refresh();
        return;
      }
      if (message.type === 'toggleOption') {
        if (message.option === 'whitespace') {
          options.includeWhitespace = !options.includeWhitespace;
        } else if (message.option === 'comment') {
          options.includeComments = !options.includeComments;
        } else {
          return;
        }
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
      } else if (message.type === 'copyToRight') {
        try {
          await fs.promises.mkdir(path.dirname(rightUri.fsPath), { recursive: true });
          await fs.promises.cp(leftUri.fsPath, rightUri.fsPath, { recursive: true });
        } catch (err) {
          vscode.window.showErrorMessage(
            `Batch Compare: failed to copy ${message.relPath} — ${
              err instanceof Error ? err.message : String(err)
            }`
          );
          return;
        }
        await refresh();
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
  <title>Batch Compare</title>
</head>
<body>
  <div id="top">
    <div id="toolbar">
      <button id="toggle-whitespace" class="toggle" title="Include whitespace differences in comparison">Whitespace</button>
      <button id="toggle-comment" class="toggle" title="Include comment differences in comparison">Comment</button>
      <span class="spacer"></span>
      <button id="swap" title="Swap left and right folders">⇄ Swap</button>
      <button id="expand-diff-only" title="Expand Diff Only">Expand Diff Only</button>
      <button id="expand-all" title="Expand All">Expand All</button>
      <button id="collapse-all" title="Collapse All">Collapse All</button>
      <button id="reload" title="Reload and compare again">⟳ Reload</button>
    </div>
    <div id="header">
      <div id="left-name" class="root-name"></div>
      <div class="gutter"></div>
      <div id="right-name" class="root-name"></div>
    </div>
  </div>
  <div id="tree"></div>

  <div id="loading-overlay">
    <div class="loading-spinner"></div>
    <div id="loading-text">Comparing...</div>
  </div>

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

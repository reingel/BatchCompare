import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CompareOptions, DEFAULT_COMPARE_OPTIONS, compareFolders, DiffNode } from './compare';
import { createFileComparePanel } from './filePanel';

/** 좌우를 맞바꾼다. 비교 결과는 대칭이므로 onlyLeft/onlyRight만 뒤집으면 된다. */
function mirrorTree(nodes: DiffNode[]): void {
  for (const node of nodes) {
    if (node.status === 'onlyLeft') {
      node.status = 'onlyRight';
    } else if (node.status === 'onlyRight') {
      node.status = 'onlyLeft';
    }
    if (node.children) {
      mirrorTree(node.children);
    }
  }
}

function markSame(node: DiffNode): void {
  node.status = 'same';
  for (const child of node.children ?? []) {
    markSame(child);
  }
}

/**
 * 좌→우 복사가 끝난 항목의 상태만 갱신한다. 복사본은 원본과 바이트 단위로
 * 같으므로 어떤 비교 옵션에서도 'same'이며, 조상 폴더는 자식 상태로 다시 계산한다.
 */
function markCopied(nodes: DiffNode[], relPath: string): void {
  const chain: DiffNode[] = [];
  let level = nodes;
  for (const segment of relPath.split('/')) {
    const found = level.find((node) => node.name === segment);
    if (!found) {
      return;
    }
    chain.push(found);
    level = found.children ?? [];
  }

  markSame(chain.pop()!);
  for (let i = chain.length - 1; i >= 0; i--) {
    const dir = chain[i];
    const status = (dir.children ?? []).every((c) => c.status === 'same')
      ? 'same'
      : 'modified';
    if (dir.status === status) {
      break;
    }
    dir.status = status;
  }
}

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

  // 현재 화면에 그려진 트리. swap/복사처럼 결과를 이미 알 수 있는 동작은
  // 이 트리를 직접 고쳐서 보내고, 다시 비교(compareFolders)하지 않는다.
  let currentTree = tree;

  const postTree = (preserveState: boolean) => {
    panel.title = `${path.basename(leftRoot.fsPath)} ↔ ${path.basename(rightRoot.fsPath)}`;
    panel.webview.postMessage({
      type: 'init',
      tree: currentTree,
      leftName: leftRoot.fsPath,
      rightName: rightRoot.fsPath,
      options,
      preserveState,
    });
  };

  const refresh = async () => {
    currentTree = await compareFolders(
      leftRoot.fsPath,
      rightRoot.fsPath,
      getExclude(),
      options
    );
    postTree(false);
  };

  panel.webview.onDidReceiveMessage(
    async (message: WebviewMessage) => {
      if (message.type === 'ready') {
        // webview가 다시 로드되어도 다시 비교하지 않고 현재 트리를 그대로 보낸다.
        postTree(false);
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
        mirrorTree(currentTree);
        postTree(true);
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
        createFileComparePanel(context, leftUri, rightUri, options);
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
          panel.webview.postMessage({ type: 'copied', relPath: message.relPath, ok: false });
          return;
        }
        // 복사한 항목만 갱신한다. 전체를 다시 비교하지 않으므로 항목이 많아도 즉시 반영된다.
        markCopied(currentTree, message.relPath);
        panel.webview.postMessage({ type: 'copied', relPath: message.relPath, ok: true });
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

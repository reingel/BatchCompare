import * as path from 'path';
import * as vscode from 'vscode';
import { compareFolders } from './compare';
import { GitCommit, extractCommit, getCommits, getHeadHash, getUncommittedCount } from './git';
import { GitGraphBuilder } from './gitGraph';
import { createComparePanel } from './panel';

const PAGE_SIZE = 300;

interface GitWebviewMessage {
  type: 'ready' | 'loadMore' | 'compare';
  leftHash?: string;
  rightHash?: string;
  leftShort?: string;
  rightShort?: string;
}

interface GitWebviewCommit extends GitCommit {
  graph: {
    column: number;
    color: number;
    tracks: { x0: number; y0: number; x1: number; y1: number; color: number }[];
  };
  uncommitted?: boolean;
}

export function createGitHistoryPanel(
  context: vscode.ExtensionContext,
  repoRoot: string
): void {
  const panel = vscode.window.createWebviewPanel(
    'batchCompareGit',
    `Git History: ${path.basename(repoRoot)}`,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      retainContextWhenHidden: true,
    }
  );

  const scriptUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, 'media', 'git.js')
  );
  const styleUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, 'media', 'git.css')
  );
  const nonce = getNonce();

  panel.webview.html = getHtml(panel.webview, scriptUri, styleUri, nonce);

  let loaded = 0;
  let graphBuilder = new GitGraphBuilder();

  const sendCommits = async (append: boolean) => {
    const commits = await getCommits(repoRoot, loaded, PAGE_SIZE + 1);
    const hasMore = commits.length > PAGE_SIZE;
    const page = hasMore ? commits.slice(0, PAGE_SIZE) : commits;
    loaded += page.length;

    const rows: GitWebviewCommit[] = [];

    // 첫 페이지 맨 위에는 커밋되지 않은 작업 트리 변경사항을 가상의 행으로 보여준다.
    if (!append && page.length > 0) {
      const [uncommittedCount, headHash] = await Promise.all([
        getUncommittedCount(repoRoot),
        getHeadHash(repoRoot),
      ]);
      if (uncommittedCount > 0 && headHash) {
        const graph = graphBuilder.processCommit('__uncommitted__', [headHash]);
        rows.push({
          hash: '__uncommitted__',
          shortHash: '',
          parents: [headHash],
          author: '',
          date: '',
          refs: '',
          subject: `Uncommitted Changes (${uncommittedCount})`,
          graph,
          uncommitted: true,
        });
      }
    }

    for (const commit of page) {
      const graph = graphBuilder.processCommit(commit.hash, commit.parents);
      rows.push({ ...commit, graph });
    }

    panel.webview.postMessage({
      type: 'commits',
      commits: rows,
      append,
      hasMore,
      repoPath: repoRoot,
    });
  };

  panel.webview.onDidReceiveMessage(
    async (message: GitWebviewMessage) => {
      if (message.type === 'ready') {
        loaded = 0;
        graphBuilder = new GitGraphBuilder();
        await sendCommits(false);
        return;
      }
      if (message.type === 'loadMore') {
        await sendCommits(true);
        return;
      }
      if (message.type === 'compare') {
        const { leftHash, rightHash, leftShort, rightShort } = message;
        if (!leftHash || !rightHash || !leftShort || !rightShort) {
          return;
        }
        try {
          const exclude = vscode.workspace
            .getConfiguration('batchCompare')
            .get<string[]>('exclude', []);
          const { left, right, tree } = await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Comparing ${leftShort} ↔ ${rightShort}...`,
            },
            async () => {
              const [left, right] = await Promise.all([
                extractCommit(repoRoot, leftHash, leftShort),
                extractCommit(repoRoot, rightHash, rightShort),
              ]);
              const tree = await compareFolders(left, right, exclude);
              return { left, right, tree };
            }
          );
          createComparePanel(
            context,
            vscode.Uri.file(left),
            vscode.Uri.file(right),
            tree
          );
        } catch (err) {
          vscode.window.showErrorMessage(
            `Batch Compare: failed to compare commits — ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
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
  <title>Git History</title>
</head>
<body>
  <div id="sticky-top">
    <div id="top">
      <div id="repo-path"></div>
      <div id="hint">Ctrl/Cmd+Click two commits to compare (older one becomes the left side).</div>
    </div>
    <div id="header">
      <span class="cell graph-cell" id="graph-col-header">Graph</span>
      <span class="cell description">Description</span>
      <span class="cell date">Date</span>
      <span class="cell author">Author</span>
      <span class="cell hash">Commit</span>
    </div>
  </div>
  <div id="commits"></div>
  <button id="load-more" hidden>Load More</button>
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

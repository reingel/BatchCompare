import * as path from 'path';
import * as vscode from 'vscode';
import { compareFolders } from './compare';
import { GitCommit, extractCommit, getCommits, getHeadHash, getUncommittedCount } from './git';
import { GitGraphBuilder } from './gitGraph';
import { createComparePanel } from './panel';

const UNCOMMITTED_HASH = '__uncommitted__';

interface GitWebviewCommit extends GitCommit {
  graph: {
    column: number;
    color: number;
    tracks: { x0: number; y0: number; x1: number; y1: number; color: number }[];
  };
  uncommitted?: boolean;
}

interface CompareSide {
  repoIndex: number;
  hash: string;
  shortHash: string;
}

interface GitWebviewMessage {
  type: 'ready' | 'compare' | 'info';
  left?: CompareSide;
  right?: CompareSide;
  text?: string;
}

async function buildRepoRows(repoPath: string): Promise<GitWebviewCommit[]> {
  const commits = await getCommits(repoPath);
  const graphBuilder = new GitGraphBuilder();
  const rows: GitWebviewCommit[] = [];

  if (commits.length > 0) {
    const [uncommittedCount, headHash] = await Promise.all([
      getUncommittedCount(repoPath),
      getHeadHash(repoPath),
    ]);
    if (uncommittedCount > 0 && headHash) {
      const graph = graphBuilder.processCommit(UNCOMMITTED_HASH, [headHash]);
      rows.push({
        hash: UNCOMMITTED_HASH,
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

  for (const commit of commits) {
    const graph = graphBuilder.processCommit(commit.hash, commit.parents);
    rows.push({ ...commit, graph });
  }

  return rows;
}

export function createGitHistoryPanel(
  context: vscode.ExtensionContext,
  repoRoots: string[]
): void {
  const title =
    repoRoots.length === 2
      ? `Git Compare: ${path.basename(repoRoots[0])} ↔ ${path.basename(repoRoots[1])}`
      : `Git History: ${path.basename(repoRoots[0])}`;

  const panel = vscode.window.createWebviewPanel(
    'batchCompareGit',
    title,
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

  const resolveSide = async (side: CompareSide): Promise<{ dir: string; label: string }> => {
    const repoRoot = repoRoots[side.repoIndex];
    if (side.hash === UNCOMMITTED_HASH) {
      return { dir: repoRoot, label: 'Working Tree' };
    }
    const dir = await extractCommit(repoRoot, side.hash, side.shortHash);
    return { dir, label: side.shortHash };
  };

  panel.webview.onDidReceiveMessage(
    async (message: GitWebviewMessage) => {
      if (message.type === 'ready') {
        const repos = await Promise.all(
          repoRoots.map(async (repoRoot, index) => ({
            index,
            repoPath: repoRoot,
            commits: await buildRepoRows(repoRoot),
          }))
        );
        panel.webview.postMessage({ type: 'init', repos });
        return;
      }
      if (message.type === 'info') {
        if (message.text) {
          vscode.window.showInformationMessage(message.text);
        }
        return;
      }
      if (message.type === 'compare') {
        const { left, right } = message;
        if (!left || !right) {
          return;
        }
        try {
          const exclude = vscode.workspace
            .getConfiguration('batchCompare')
            .get<string[]>('exclude', []);
          const { leftDir, rightDir, tree } = await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: 'Comparing...',
            },
            async () => {
              const [l, r] = await Promise.all([resolveSide(left), resolveSide(right)]);
              const tree = await compareFolders(l.dir, r.dir, exclude);
              return { leftDir: l.dir, rightDir: r.dir, tree };
            }
          );
          createComparePanel(
            context,
            vscode.Uri.file(leftDir),
            vscode.Uri.file(rightDir),
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
  <div id="panels"></div>
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

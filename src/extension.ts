import * as vscode from 'vscode';
import { compareFolders } from './compare';
import { cleanupExtractedDirs, getRepoRoot } from './git';
import { createGitHistoryPanel } from './gitPanel';
import { createComparePanel } from './panel';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'batchCompare.compare',
      async (_uri: vscode.Uri, uris?: vscode.Uri[]) => {
        const selected = uris && uris.length ? uris : _uri ? [_uri] : [];

        let left: vscode.Uri;
        let right: vscode.Uri;
        if (selected.length === 2) {
          [left, right] = selected;
        } else if (selected.length === 1) {
          // 폴더 하나만 선택한 경우: 선택한 폴더를 우측에 두고,
          // 좌측 폴더는 다이얼로그로 선택받는다.
          right = selected[0];
          const picked = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            openLabel: 'Select as Left Folder',
            title: 'Select the left folder to compare against',
          });
          if (!picked || picked.length === 0) {
            return;
          }
          left = picked[0];
        } else {
          vscode.window.showWarningMessage(
            'Batch Compare: select one or two folders in the Explorer.'
          );
          return;
        }

        const stats = await Promise.all(
          [left, right].map((u) => vscode.workspace.fs.stat(u))
        );
        if (stats.some((s) => s.type !== vscode.FileType.Directory)) {
          vscode.window.showWarningMessage(
            'Batch Compare: both selected items must be folders.'
          );
          return;
        }

        const exclude = vscode.workspace
          .getConfiguration('batchCompare')
          .get<string[]>('exclude', []);

        const tree = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Comparing folders...',
          },
          () => compareFolders(left.fsPath, right.fsPath, exclude)
        );

        createComparePanel(context, left, right, tree);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('batchCompare.gitCompare', async () => {
      // 워크스페이스 폴더들에서 git 저장소 루트를 찾는다.
      const folders = vscode.workspace.workspaceFolders ?? [];
      const roots = new Set<string>();
      for (const folder of folders) {
        const root = await getRepoRoot(folder.uri.fsPath);
        if (root) {
          roots.add(root);
        }
      }

      let repoRoot: string | undefined;
      if (roots.size === 1) {
        repoRoot = [...roots][0];
      } else if (roots.size > 1) {
        repoRoot = await vscode.window.showQuickPick([...roots], {
          title: 'Batch Compare: Select a git repository',
        });
      } else {
        // 워크스페이스에 git 저장소가 없으면 다이얼로그로 선택받는다.
        const picked = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          openLabel: 'Select Git Repository',
          title: 'Select a git repository folder',
        });
        if (!picked || picked.length === 0) {
          return;
        }
        repoRoot = await getRepoRoot(picked[0].fsPath);
        if (!repoRoot) {
          vscode.window.showWarningMessage(
            'Batch Compare: the selected folder is not a git repository.'
          );
          return;
        }
      }
      if (!repoRoot) {
        return;
      }

      createGitHistoryPanel(context, repoRoot);
    })
  );
}

export function deactivate(): void {
  cleanupExtractedDirs();
}

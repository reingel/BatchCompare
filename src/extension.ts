import * as vscode from 'vscode';
import { compareFolders } from './compare';
import { cleanupExtractedDirs, getRepoRoot } from './git';
import { createGitHistoryPanel } from './gitPanel';
import { createComparePanel } from './panel';
import { createFileComparePanel } from './filePanel';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand(
    'batchCompare.compareFiles',
    async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
      try {
        const selected = uris?.length ? uris : uri ? [uri] : [];
        if (selected.length > 2) {
          void vscode.window.showWarningMessage('Batch Compare: select one or two files.');
          return;
        }
        let left: vscode.Uri;
        let right: vscode.Uri;
        if (selected.length === 2) [left, right] = selected;
        else {
          const pick = async (side: string) => (await vscode.window.showOpenDialog({
            canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
            openLabel: `Select ${side} File`, title: `Select the ${side.toLowerCase()} file to compare`,
          }))?.[0];
          const rightFile = selected[0] ?? await pick('Right');
          if (!rightFile) return;
          const leftFile = await pick('Left');
          if (!leftFile) return;
          left = leftFile; right = rightFile;
        }
        const stats = await Promise.all([left, right].map(file => vscode.workspace.fs.stat(file)));
        if (stats.some(stat => !(stat.type & vscode.FileType.File))) {
          void vscode.window.showWarningMessage('Batch Compare: both selected items must be files.');
          return;
        }
        createFileComparePanel(context, left, right);
      } catch (error) {
        void vscode.window.showErrorMessage(`Batch Compare: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  ));
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
    vscode.commands.registerCommand(
      'batchCompare.gitCompare',
      async (_uri: vscode.Uri, uris?: vscode.Uri[]) => {
        const selected = uris && uris.length ? uris : _uri ? [_uri] : [];

        const resolveRepo = async (uri: vscode.Uri): Promise<string | undefined> => {
          const stat = await vscode.workspace.fs.stat(uri);
          if (stat.type !== vscode.FileType.Directory) {
            return undefined;
          }
          return getRepoRoot(uri.fsPath);
        };

        let repoRoots: string[];
        if (selected.length === 2) {
          // 탐색기에서 두 폴더를 Ctrl/Cmd+Click으로 선택한 경우: 그대로 좌우 저장소로 사용한다.
          const [rootA, rootB] = await Promise.all(selected.map(resolveRepo));
          if (!rootA || !rootB) {
            vscode.window.showWarningMessage(
              'Batch Compare: both selected folders must be inside a git repository.'
            );
            return;
          }
          repoRoots = [rootA, rootB];
        } else if (selected.length === 1) {
          // 한 저장소의 서로 다른 커밋을 비교한다.
          const root = await resolveRepo(selected[0]);
          if (!root) {
            vscode.window.showWarningMessage(
              'Batch Compare: the selected folder is not a git repository.'
            );
            return;
          }
          repoRoots = [root];
        } else if (selected.length === 0) {
          // 커맨드 팔레트 등 탐색기 선택 없이 호출된 경우: 워크스페이스에서 저장소를 찾는다.
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
          repoRoots = [repoRoot];
        } else {
          vscode.window.showWarningMessage(
            'Batch Compare: select one or two folders in the Explorer.'
          );
          return;
        }

        createGitHistoryPanel(context, repoRoots);
      }
    )
  );
}

export function deactivate(): void {
  cleanupExtractedDirs();
}

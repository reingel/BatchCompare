import * as vscode from 'vscode';
import { compareFolders } from './compare';
import { createComparePanel } from './panel';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'folderCompare.compare',
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
            'Folder Compare: select one or two folders in the Explorer.'
          );
          return;
        }

        const stats = await Promise.all(
          [left, right].map((u) => vscode.workspace.fs.stat(u))
        );
        if (stats.some((s) => s.type !== vscode.FileType.Directory)) {
          vscode.window.showWarningMessage(
            'Folder Compare: both selected items must be folders.'
          );
          return;
        }

        const exclude = vscode.workspace
          .getConfiguration('folderCompare')
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
}

export function deactivate(): void {}

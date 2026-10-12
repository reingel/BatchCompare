# BatchCompare

Compare two folders side by side in Visual Studio Code.

## Features

### Starting a comparison

- Select **two folders** in the Explorer, right-click, and choose **Batch Compare** to compare them directly.
- Select **one folder**, right-click, and choose **Batch Compare** — the selected folder becomes the right side, and a dialog lets you pick the left folder to compare against.
- Click either path shown at the top of the compare view to reopen the folder-picker dialog and swap in a different folder for that side.

### Comparing Git commits

- Right-click **one folder** in a Git repository and choose **Batch Compare: Git History**, or run that command from the Command Palette.
- Select two commits with **Ctrl/Cmd+Click**. **Shift+Click** selects the first and second endpoints, even when other commits lie between them.
- Click **Compare Selected Commits**, or right-click a selected commit and choose **Batch Compare: Git Commit**. The commit lower in the history is shown on the left; the commit higher in the history is shown on the right.
- The history includes commits from all local branches, remote-tracking branches, and tags, plus **Uncommitted Changes** when the working tree has changes.
- To compare commits from **two repositories**, select two folders in the Explorer and open **Batch Compare: Git History**, then select one commit in each repository.
- The comparison opens the same folder tree and file diff view used for folder comparisons. Commit snapshots are extracted to separate temporary folders without checking out commits or changing your working tree.

### Comparing trees

- A two-column tree view shows both folder structures aligned by relative path, connected with expandable tree guide lines.
- By default, folders that are fully identical start **collapsed**, while folders containing differences are automatically **expanded** so you see what changed right away.
- The differing segment between the two root paths (e.g. `.../project/`**`v1`**` ` vs `.../project/`**`v2`**) is highlighted at the top, making it easy to spot which folders you're comparing.
- Files and folders are color- and background-highlighted by status:
  - **Modified** — exists on both sides with different content (red text + background)
  - **Only in left** — exists only in the left folder (red-tinted background on the left cell)
  - **Only in right** — exists only in the right folder (green-tinted background on the right cell)
  - **Identical** — shown in a neutral grayscale shade, varied by file extension so different file types are still easy to tell apart at a glance
- Alternating row backgrounds (zebra striping) make it easier to follow a row across both columns.

### Toolbar

The toolbar above the folder paths provides:

- **⇄ Swap** — swap the left and right folders and re-compare.
- **Expand Diff Only** — collapse everything except the folders that contain differences (the default view).
- **Expand All** / **Collapse All** — expand or collapse every folder.
- **⟳ Reload** — re-scan both folders and refresh the comparison (useful after external changes).

### Opening files

- Click a file that exists on both sides to open it in VS Code's built-in diff editor.
- Click a file that exists on one side only to open it in a regular editor.

## Settings

- `batchCompare.exclude` — names of files or folders to skip during comparison (default: `.git`, `node_modules`).

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

- Click a file that exists on both sides to open the extension's file compare view, inheriting the folder comparison's Whitespace and Comment options.
- Click a file that exists on one side only to open it in a regular editor.

### Comparing files

- Select **two files** in the Explorer, right-click, and choose **Batch Compare: Files**.
- With **one file** selected, that file becomes the right side and a dialog lets you pick the left file. You can also run **Batch Compare: Files** from the Command Palette to pick both files.
- **Whitespace: ON** includes whitespace differences. **OFF** ignores spaces, tabs, and empty lines when matching lines (default: OFF).
- **Comment: ON** highlights comment differences (default). **OFF** ignores recognized comment differences. Both sides always display the full original text, including comments, whitespace and blank lines; the switches only control difference highlighting and navigation.
- The comparison uses Monaco editors with synchronized scrolling, aligned insertions/deletions, native selection/copy, and **Ctrl/Cmd+F** search. Language coloring uses installed VS Code TextMate grammars and the current theme's token colors, including `editor.tokenColorCustomizations`. Theme/font changes are reflected while the view is open. Language-server semantic coloring is not replicated.
- Within a changed line, differing character ranges receive stronger removed/inserted backgrounds from the VS Code theme. Ignored whitespace and comments remain visible and are excluded from character highlights.
- Comment filtering uses the left file's extension and the same lightweight scanner as folder comparison. It supports common C-style, Python/shell, HTML/XML, SQL, CSS and other comment styles. Unsupported extensions retain their comments; complex language syntax such as regex literals, nested comments, and template interpolation is not fully parsed.
- Use **Previous / Next** to jump between difference blocks, and **Reload** to read the files again. Unsaved changes in open editors are included. The compare view is read-only.
- **Open Original Diff** opens VS Code's standard diff editor. Use it for editing, binary files, files over 2 MB, or files over 20,000 lines. Very large, completely different text comparisons may show a single replacement block to keep the comparison responsive.

## Settings

- `batchCompare.exclude` — names of files or folders to skip during comparison (default: `.git`, `node_modules`).

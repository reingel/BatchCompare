// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  const ROW_H = 24;
  const LANE_W = 16;
  const LANE_PAD = 10;
  const LANE_COLORS = [
    'var(--vscode-charts-blue, #4a9eff)',
    'var(--vscode-charts-purple, #d16bd1)',
    'var(--vscode-charts-green, #89d185)',
    'var(--vscode-charts-orange, #d18616)',
    'var(--vscode-charts-red, #e05561)',
    'var(--vscode-charts-yellow, #cca700)',
  ];

  /** @type {Array<{index:number, repoPath:string, commits:any[], selected:string[], anchorIndex:number|null, commitsEl?:HTMLElement}>} */
  let panels = [];

  const panelsEl = document.getElementById('panels');
  const compareButton = /** @type {HTMLButtonElement|null} */ (document.getElementById('compare-selected'));
  compareButton?.addEventListener('click', compareSelectedCommits);

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'init') {
      panels = message.repos.map((r) => ({ ...r, selected: [], anchorIndex: null }));
      renderAll();
    }
  });

  function graphWidth(commits) {
    let max = 0;
    for (const c of commits) {
      max = Math.max(max, c.graph.column);
      for (const t of c.graph.tracks) {
        max = Math.max(max, t.x0, t.x1);
      }
    }
    return LANE_PAD * 2 + (max + 1) * LANE_W;
  }

  function laneX(col) {
    return LANE_PAD + col * LANE_W + LANE_W / 2;
  }

  function renderAll() {
    document.getElementById('loading-overlay')?.classList.add('hidden');
    if (!panelsEl) {
      return;
    }
    panelsEl.textContent = '';
    panelsEl.classList.toggle('dual', panels.length === 2);

    const hint =
      panels.length === 2
        ? 'Select one commit in each repository, then click Compare Selected Commits.'
        : 'Select a commit, then Ctrl/Cmd+Click or Shift+Click a second commit and click Compare Selected Commits.';

    for (const panel of panels) {
      const width = graphWidth(panel.commits);

      const panelEl = document.createElement('div');
      panelEl.className = 'repo-panel';

      const stickyTop = document.createElement('div');
      stickyTop.className = 'sticky-top';

      const top = document.createElement('div');
      top.className = 'top';
      const repoPathEl = document.createElement('div');
      repoPathEl.className = 'repo-path';
      repoPathEl.textContent = panel.repoPath;
      top.appendChild(repoPathEl);
      const hintEl = document.createElement('div');
      hintEl.className = 'hint';
      hintEl.textContent = hint;
      top.appendChild(hintEl);
      stickyTop.appendChild(top);

      const header = document.createElement('div');
      header.className = 'header';
      const graphHeader = document.createElement('span');
      graphHeader.className = 'cell graph-cell';
      graphHeader.style.width = width + 'px';
      graphHeader.textContent = 'Graph';
      header.appendChild(graphHeader);
      header.appendChild(makeCell('description', 'Description'));
      header.appendChild(makeCell('date', 'Date'));
      header.appendChild(makeCell('author', 'Author'));
      header.appendChild(makeCell('hash', 'Commit'));
      stickyTop.appendChild(header);

      panelEl.appendChild(stickyTop);

      const commitsEl = document.createElement('div');
      commitsEl.className = 'commits';
      for (let i = 0; i < panel.commits.length; i++) {
        commitsEl.appendChild(renderCommit(panel, panel.commits[i], i, width));
      }
      panelEl.appendChild(commitsEl);
      panel.commitsEl = commitsEl;

      panelsEl.appendChild(panelEl);
    }

    updateSelectionClasses();
  }

  function makeCell(cls, text) {
    const el = document.createElement('span');
    el.className = 'cell ' + cls;
    el.textContent = text;
    return el;
  }

  function renderGraphCell(commit, width) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(ROW_H));
    svg.classList.add('graph-svg');

    for (const track of commit.graph.tracks) {
      const x0 = laneX(track.x0);
      const y0 = track.y0 * ROW_H;
      const x1 = laneX(track.x1);
      const y1 = track.y1 * ROW_H;
      const color = LANE_COLORS[track.color % LANE_COLORS.length];
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      let d;
      if (x0 === x1) {
        d = `M ${x0} ${y0} L ${x1} ${y1}`;
      } else {
        const midY = (y0 + y1) / 2;
        d = `M ${x0} ${y0} C ${x0} ${midY}, ${x1} ${midY}, ${x1} ${y1}`;
      }
      path.setAttribute('d', d);
      path.setAttribute('stroke', color);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke-width', '2');
      svg.appendChild(path);
    }

    const cx = laneX(commit.graph.column);
    const cy = ROW_H / 2;
    const color = LANE_COLORS[commit.graph.color % LANE_COLORS.length];
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', String(cx));
    circle.setAttribute('cy', String(cy));
    circle.setAttribute('r', commit.uncommitted ? '4' : '5');
    circle.setAttribute('stroke', color);
    circle.setAttribute('stroke-width', '2');
    circle.setAttribute('fill', commit.uncommitted ? 'var(--vscode-editor-background)' : color);
    svg.appendChild(circle);

    return svg;
  }

  function renderCommit(panel, commit, index, width) {
    const row = document.createElement('div');
    row.className = 'commit' + (index % 2 === 1 ? ' stripe' : '');
    if (commit.uncommitted) {
      row.classList.add('uncommitted');
    }
    row.dataset.hash = commit.hash;

    const graphCell = document.createElement('span');
    graphCell.className = 'cell graph-cell';
    graphCell.style.width = width + 'px';
    graphCell.appendChild(renderGraphCell(commit, width));
    row.appendChild(graphCell);

    const description = document.createElement('span');
    description.className = 'cell description';

    if (commit.refs) {
      for (const ref of commit.refs.split(', ')) {
        const badge = document.createElement('span');
        badge.className = 'ref' + (ref.startsWith('tag: ') ? ' tag' : '');
        badge.textContent = ref.replace(/^tag: /, '').replace(/^HEAD -> /, '');
        description.appendChild(badge);
      }
    }

    const subject = document.createElement('span');
    const isMerge = commit.parents && commit.parents.length > 1;
    subject.className = 'subject' + (isMerge ? ' dim' : '');
    subject.textContent = commit.subject;
    subject.title = commit.subject;
    description.appendChild(subject);
    row.appendChild(description);

    const date = document.createElement('span');
    date.className = 'cell date';
    date.textContent = commit.date;
    row.appendChild(date);

    const author = document.createElement('span');
    author.className = 'cell author';
    author.textContent = commit.author;
    row.appendChild(author);

    const hash = document.createElement('span');
    hash.className = 'cell hash';
    hash.textContent = commit.shortHash;
    row.appendChild(hash);

    row.addEventListener('mousedown', (event) => {
      if (event.shiftKey) {
        // Shift+Click 시 브라우저 기본 텍스트 선택이 함께 일어나지 않도록 막는다.
        event.preventDefault();
      }
    });
    row.addEventListener('click', (event) => {
      handleClick(panel, commit.hash, index, event);
    });
    row.addEventListener('contextmenu', (event) => {
      handleContextMenu(panel, commit.hash, event);
    });
    return row;
  }

  function handleClick(panel, hash, index, event) {
    if (event.shiftKey && panel.anchorIndex !== null) {
      // 범위 전체가 아닌 비교할 두 끝점만 선택한다.
      panel.selected = [...new Set([panel.commits[panel.anchorIndex].hash, hash])];
    } else if (event.ctrlKey || event.metaKey) {
      // Ctrl(win)/Cmd(mac)+Click으로 두 번째 이후 커밋을 선택에 추가/제거한다.
      const i = panel.selected.indexOf(hash);
      if (i >= 0) {
        panel.selected.splice(i, 1);
      } else {
        panel.selected.push(hash);
      }
      panel.anchorIndex = index;
    } else {
      // 아무 것도 선택되지 않았거나 다른 커밋을 클릭하면 선택이 그 커밋으로 옮겨간다.
      panel.selected = [hash];
      panel.anchorIndex = index;
    }
    updateSelectionClasses();
  }

  function handleContextMenu(panel, hash, event) {
    event.preventDefault();
    if (!panel.selected.includes(hash)) {
      return;
    }
    showContextMenu(event.clientX, event.clientY, [
      { label: 'Batch Compare: Git Commit', action: compareSelectedCommits },
    ]);
  }

  function compareSelectedCommits() {
    /** @type {{repoIndex:number, hash:string, shortHash:string}} */
    let left;
    /** @type {{repoIndex:number, hash:string, shortHash:string}} */
    let right;

    if (panels.length === 1) {
      const panel = panels[0];
      if (panel.selected.length !== 2) {
        vscode.postMessage({ type: 'info', text: 'Select two commits.' });
        return;
      }
      // 커밋 목록은 최신순(미커밋 변경사항이 맨 위)이므로 인덱스가 큰 쪽이 더 오래된 커밋.
      // 오래된 커밋을 좌측, 최신 커밋을 우측에 두어 old → new 방향으로 비교한다.
      const a = panel.commits.findIndex((c) => c.hash === panel.selected[0]);
      const b = panel.commits.findIndex((c) => c.hash === panel.selected[1]);
      const older = panel.commits[Math.max(a, b)];
      const newer = panel.commits[Math.min(a, b)];
      left = { repoIndex: 0, hash: older.hash, shortHash: older.shortHash };
      right = { repoIndex: 0, hash: newer.hash, shortHash: newer.shortHash };
    } else {
      const [leftPanel, rightPanel] = panels;
      if (leftPanel.selected.length !== 1 || rightPanel.selected.length !== 1) {
        vscode.postMessage({ type: 'info', text: 'Select two commits.' });
        return;
      }
      const l = leftPanel.commits.find((c) => c.hash === leftPanel.selected[0]);
      const r = rightPanel.commits.find((c) => c.hash === rightPanel.selected[0]);
      left = { repoIndex: leftPanel.index, hash: l.hash, shortHash: l.shortHash };
      right = { repoIndex: rightPanel.index, hash: r.hash, shortHash: r.shortHash };
    }

    vscode.postMessage({ type: 'compare', left, right });
  }

  let contextMenuEl = null;

  function closeContextMenu() {
    if (contextMenuEl) {
      contextMenuEl.remove();
      contextMenuEl = null;
    }
  }

  function showContextMenu(x, y, items) {
    closeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    for (const item of items) {
      const entry = document.createElement('div');
      entry.className = 'context-menu-item';
      entry.textContent = item.label;
      entry.addEventListener('click', () => {
        closeContextMenu();
        item.action();
      });
      menu.appendChild(entry);
    }
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 4);
    const top = Math.min(y, window.innerHeight - rect.height - 4);
    menu.style.left = Math.max(0, left) + 'px';
    menu.style.top = Math.max(0, top) + 'px';
    contextMenuEl = menu;
  }

  document.addEventListener('click', closeContextMenu);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeContextMenu();
    }
  });

  function updateSelectionClasses() {
    const canCompare = panels.length === 1
      ? panels[0].selected.length === 2
      : panels.length === 2 && panels.every((panel) => panel.selected.length === 1);
    if (compareButton) {
      compareButton.disabled = !canCompare;
    }
    const selectionHint = document.getElementById('selection-hint');
    if (selectionHint) {
      selectionHint.textContent = canCompare
        ? 'Ready to compare.'
        : panels.length === 2
          ? 'Select one commit in each repository.'
          : 'Select two commits to compare.';
    }
    for (const panel of panels) {
      if (!panel.commitsEl) {
        continue;
      }
      const rows = panel.commitsEl.querySelectorAll('.commit');
      for (const row of rows) {
        const el = /** @type {HTMLElement} */ (row);
        el.classList.toggle('selected', panel.selected.includes(el.dataset.hash || ''));
      }
    }
  }

  vscode.postMessage({ type: 'ready' });
})();

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

  /** @type {Array<any>} */
  let commits = [];
  /** @type {string[]} 선택된 커밋 해시 (최대 2개, 선택한 순서 유지) */
  let selected = [];
  let maxColumn = 0;

  const commitsEl = document.getElementById('commits');
  const repoPathEl = document.getElementById('repo-path');
  const loadMoreBtn = document.getElementById('load-more');
  const graphColEl = document.getElementById('graph-col-header');

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'commits') {
      commits = message.append ? commits.concat(message.commits) : message.commits;
      if (repoPathEl) {
        repoPathEl.textContent = message.repoPath;
      }
      if (loadMoreBtn) {
        loadMoreBtn.hidden = !message.hasMore;
        loadMoreBtn.textContent = 'Load More';
        loadMoreBtn.removeAttribute('disabled');
      }
      recomputeMaxColumn();
      render();
    }
  });

  if (loadMoreBtn) {
    loadMoreBtn.addEventListener('click', () => {
      loadMoreBtn.textContent = 'Loading...';
      loadMoreBtn.setAttribute('disabled', '');
      vscode.postMessage({ type: 'loadMore' });
    });
  }

  function recomputeMaxColumn() {
    let max = 0;
    for (const c of commits) {
      max = Math.max(max, c.graph.column);
      for (const t of c.graph.tracks) {
        max = Math.max(max, t.x0, t.x1);
      }
    }
    maxColumn = max;
  }

  function graphWidth() {
    return LANE_PAD * 2 + (maxColumn + 1) * LANE_W;
  }

  function render() {
    if (!commitsEl) {
      return;
    }
    const width = graphWidth();
    if (graphColEl) {
      graphColEl.style.width = width + 'px';
    }
    commitsEl.textContent = '';
    for (let i = 0; i < commits.length; i++) {
      commitsEl.appendChild(renderCommit(commits[i], i, width));
    }
    updateSelection();
  }

  function laneX(col) {
    return LANE_PAD + col * LANE_W + LANE_W / 2;
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

  function renderCommit(commit, index, width) {
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

    if (!commit.uncommitted) {
      row.addEventListener('click', (event) => {
        if (event.ctrlKey || event.metaKey) {
          toggle(commit.hash);
        }
      });
    }
    return row;
  }

  function toggle(hash) {
    const i = selected.indexOf(hash);
    if (i >= 0) {
      selected.splice(i, 1);
    } else if (selected.length >= 2) {
      // 이미 2개가 선택된 상태에서 다른 커밋을 클릭하면 새로 선택을 시작한다.
      selected = [hash];
    } else {
      selected.push(hash);
    }
    updateSelection();

    if (selected.length === 2) {
      // 커밋 목록은 최신순이므로 인덱스가 큰 쪽이 오래된 커밋.
      // 오래된 커밋을 좌측, 최신 커밋을 우측에 두어 old → new 방향으로 비교한다.
      const a = commits.findIndex((c) => c.hash === selected[0]);
      const b = commits.findIndex((c) => c.hash === selected[1]);
      const older = commits[Math.max(a, b)];
      const newer = commits[Math.min(a, b)];
      vscode.postMessage({
        type: 'compare',
        leftHash: older.hash,
        rightHash: newer.hash,
        leftShort: older.shortHash,
        rightShort: newer.shortHash,
      });
    }
  }

  function updateSelection() {
    if (!commitsEl) {
      return;
    }
    const rows = commitsEl.querySelectorAll('.commit');
    for (const row of rows) {
      const el = /** @type {HTMLElement} */ (row);
      el.classList.toggle('selected', selected.includes(el.dataset.hash || ''));
    }
  }

  vscode.postMessage({ type: 'ready' });
})();

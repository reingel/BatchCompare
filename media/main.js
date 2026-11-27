// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'init') {
      render(message);
    } else if (message.type === 'copied') {
      if (message.ok) {
        applyCopied(message.relPath);
      }
      hideLoading();
    } else if (message.type === 'reloaded') {
      if (message.ok) {
        applyReloaded(message);
      }
      hideLoading();
    }
  });

  const loadingOverlay = document.getElementById('loading-overlay');
  function showLoading() {
    loadingOverlay?.classList.remove('hidden');
  }
  function hideLoading() {
    loadingOverlay?.classList.add('hidden');
  }

  const reloadBtn = document.getElementById('reload');
  if (reloadBtn) {
    reloadBtn.addEventListener('click', () => {
      showLoading();
      vscode.postMessage({ type: 'reload' });
    });
  }

  const swapBtn = document.getElementById('swap');
  if (swapBtn) {
    swapBtn.addEventListener('click', () => {
      // 좌우를 바꾸는 것은 다시 비교할 필요가 없어 즉시 끝나므로 로딩 표시를 하지 않는다.
      vscode.postMessage({ type: 'swap' });
    });
  }

  const collapseAllBtn = document.getElementById('collapse-all');
  if (collapseAllBtn) {
    collapseAllBtn.addEventListener('click', () => {
      setAllCollapsed(true);
    });
  }

  const expandAllBtn = document.getElementById('expand-all');
  if (expandAllBtn) {
    expandAllBtn.addEventListener('click', () => {
      setAllCollapsed(false);
    });
  }

  const expandDiffOnlyBtn = document.getElementById('expand-diff-only');
  if (expandDiffOnlyBtn) {
    expandDiffOnlyBtn.addEventListener('click', () => {
      expandDiffOnly();
    });
  }

  // 켜면 화이트스페이스/주석을 포함하여 비교하고, 끄면 무시하고 비교한다.
  // 실제 상태는 extension이 갖고 있으며, init 메시지의 options로 버튼 표시를 맞춘다.
  const whitespaceBtn = document.getElementById('toggle-whitespace');
  if (whitespaceBtn) {
    whitespaceBtn.addEventListener('click', () => {
      showLoading();
      vscode.postMessage({ type: 'toggleOption', option: 'whitespace' });
    });
  }

  const commentBtn = document.getElementById('toggle-comment');
  if (commentBtn) {
    commentBtn.addEventListener('click', () => {
      showLoading();
      vscode.postMessage({ type: 'toggleOption', option: 'comment' });
    });
  }

  function updateToggles(options) {
    if (!options) {
      return;
    }
    if (whitespaceBtn) {
      whitespaceBtn.classList.toggle('active', options.includeWhitespace);
    }
    if (commentBtn) {
      commentBtn.classList.toggle('active', options.includeComments);
    }
  }

  function setAllCollapsed(collapsed) {
    const nodes = treeEl.querySelectorAll('.node');
    for (const node of nodes) {
      if (node.querySelector(':scope > .children')) {
        node.classList.toggle('collapsed', collapsed);
      }
    }
    restripe();
  }

  // 완전히 동일한(내부에 차이가 없는) 폴더는 접고,
  // 차이가 있는 파일로 이어지는 경로의 폴더만 펼친다.
  function expandDiffOnly() {
    const nodes = treeEl.querySelectorAll('.node');
    for (const node of nodes) {
      if (!node.querySelector(':scope > .children')) {
        continue;
      }
      node.classList.toggle('collapsed', node.dataset.status === 'same');
    }
    restripe();
  }

  const leftNameEl = document.getElementById('left-name');
  const rightNameEl = document.getElementById('right-name');
  if (leftNameEl) {
    leftNameEl.addEventListener('click', () => {
      vscode.postMessage({ type: 'changeRoot', side: 'left' });
    });
  }
  if (rightNameEl) {
    rightNameEl.addEventListener('click', () => {
      vscode.postMessage({ type: 'changeRoot', side: 'right' });
    });
  }

  const treeEl = document.getElementById('tree');

  // 화면에 그려진 트리와, relPath로 노드/DOM/렌더링 인자를 다시 찾기 위한 색인.
  // 일부만 다시 그릴 때(복사 후 갱신) 사용한다.
  let treeData = [];
  const nodeInfo = new Map();
  const nodeElements = new Map();

  function render(message) {
    updateToggles(message.options);
    const leftName = document.getElementById('left-name');
    const rightName = document.getElementById('right-name');
    renderRootName(leftName, message.leftName, message.rightName);
    leftName.title = message.leftName + '\n(click to change)';
    renderRootName(rightName, message.rightName, message.leftName);
    rightName.title = message.rightName + '\n(click to change)';

    // swap처럼 트리 구조가 그대로인 경우에는 사용자가 펼쳐둔 상태를 유지한다.
    const collapsed = message.preserveState ? collapsedPaths() : null;

    treeData = message.tree;
    nodeInfo.clear();
    nodeElements.clear();
    treeEl.textContent = '';
    for (let i = 0; i < message.tree.length; i++) {
      const node = message.tree[i];
      const isLast = i === message.tree.length - 1;
      treeEl.appendChild(renderNode(node, isLast, null));
    }
    if (collapsed) {
      for (const node of treeData) {
        restoreCollapsed(node, collapsed);
      }
      restripe();
    } else {
      // 기본 모드: diff가 있는 경로만 펼쳐서 보여준다.
      expandDiffOnly();
    }
    hideLoading();
  }

  function collapsedPaths() {
    const paths = new Set();
    for (const [relPath, el] of nodeElements) {
      if (el.classList.contains('collapsed')) {
        paths.add(relPath);
      }
    }
    return paths;
  }

  function restoreCollapsed(node, collapsed) {
    if (!node.children || node.children.length === 0) {
      return;
    }
    const el = nodeElements.get(node.relPath);
    if (el) {
      el.classList.toggle('collapsed', collapsed.has(node.relPath));
    }
    for (const child of node.children) {
      restoreCollapsed(child, collapsed);
    }
  }

  function markSame(node) {
    node.status = 'same';
    for (const child of node.children || []) {
      markSame(child);
    }
  }

  // 복사가 끝난 항목만 다시 그린다. 전체를 다시 비교/렌더링하지 않으므로
  // 항목이 많아도 즉시 반영되고 나머지 화면 상태도 그대로 유지된다.
  function applyCopied(relPath) {
    const info = nodeInfo.get(relPath);
    const el = nodeElements.get(relPath);
    if (!info || !el) {
      return;
    }
    const collapsed = collapsedPaths();
    markSame(info.node);
    const fresh = renderNode(info.node, info.isLast, info.ancestorLines);
    el.replaceWith(fresh);
    restoreCollapsed(info.node, collapsed);
    updateAncestorStatus(relPath);
    restripe();
  }

  // 자식이 모두 same이면 폴더도 same, 아니면 modified. 바뀌지 않는 지점에서 멈춘다.
  function updateAncestorStatus(relPath) {
    const chain = [];
    let level = treeData;
    for (const segment of relPath.split('/')) {
      const found = level.find((node) => node.name === segment);
      if (!found) {
        return;
      }
      chain.push(found);
      level = found.children || [];
    }
    chain.pop();

    for (let i = chain.length - 1; i >= 0; i--) {
      const dir = chain[i];
      const status = (dir.children || []).every((c) => c.status === 'same')
        ? 'same'
        : 'modified';
      if (dir.status === status) {
        return;
      }
      dir.status = status;
      setRowStatus(dir.relPath, status);
    }
  }

  function setRowStatus(relPath, status) {
    const el = nodeElements.get(relPath);
    if (!el) {
      return;
    }
    el.dataset.status = status;
    const row = el.querySelector(':scope > .row');
    if (row) {
      row.classList.remove(
        'status-same',
        'status-modified',
        'status-onlyLeft',
        'status-onlyRight'
      );
      row.classList.add('status-' + status);
    }
  }

  // 다시 그리기 전에 relPath 하위 항목의 색인을 지운다(사라진 항목이 남지 않도록).
  function forgetSubtree(relPath) {
    const prefix = relPath + '/';
    for (const key of [...nodeElements.keys()]) {
      if (key === relPath || key.startsWith(prefix)) {
        nodeElements.delete(key);
        nodeInfo.delete(key);
      }
    }
  }

  // 이전에 보이던 폴더는 접힘 상태를 유지하고, 새로 나타난 폴더는
  // 기본 모드(diff가 있는 경로만 펼침)를 따른다.
  function applyCollapsedState(node, collapsed, known) {
    if (!node.children || node.children.length === 0) {
      return;
    }
    const el = nodeElements.get(node.relPath);
    if (el) {
      el.classList.toggle(
        'collapsed',
        known.has(node.relPath) ? collapsed.has(node.relPath) : node.status === 'same'
      );
    }
    for (const child of node.children) {
      applyCollapsedState(child, collapsed, known);
    }
  }

  // 트리의 한 항목(node)을 같은 위치에 다시 그린다.
  function rerenderNode(relPath, node, isLast, collapsed, known) {
    const info = nodeInfo.get(relPath);
    const el = nodeElements.get(relPath);
    if (!info || !el) {
      return;
    }
    forgetSubtree(relPath);
    const fresh = renderNode(node, isLast, info.ancestorLines);
    el.replaceWith(fresh);
    applyCollapsedState(node, collapsed, known);
  }

  // 우클릭 메뉴의 Reload: 해당 항목만 다시 비교한 결과를 반영한다.
  // message.node가 null이면 좌우 모두에서 사라진 항목이다.
  function applyReloaded(message) {
    const relPath = message.relPath;
    const info = nodeInfo.get(relPath);
    if (!info) {
      return;
    }
    const collapsed = collapsedPaths();
    const known = new Set(nodeElements.keys());
    const slash = relPath.lastIndexOf('/');
    const parentPath = slash >= 0 ? relPath.slice(0, slash) : null;
    const parentInfo = parentPath !== null ? nodeInfo.get(parentPath) : null;
    const siblings = parentInfo ? parentInfo.node.children : treeData;
    const index = siblings.indexOf(info.node);
    if (index < 0) {
      return;
    }

    if (message.node) {
      siblings[index] = message.node;
      rerenderNode(relPath, message.node, info.isLast, collapsed, known);
    } else {
      siblings.splice(index, 1);
      if (parentInfo && siblings.length === 0) {
        // 마지막 자식이 사라지면 부모의 트위스티도 바뀌므로 부모를 다시 그린다.
        rerenderNode(parentPath, parentInfo.node, parentInfo.isLast, collapsed, known);
      } else {
        const el = nodeElements.get(relPath);
        forgetSubtree(relPath);
        el?.remove();
        if (info.isLast && siblings.length > 0) {
          // 새로 마지막이 된 형제의 트리 연결선(└)을 고친다.
          const last = siblings[siblings.length - 1];
          rerenderNode(last.relPath, last, true, collapsed, known);
        }
      }
    }

    for (const { relPath: dirPath, status } of message.ancestors || []) {
      const dirInfo = nodeInfo.get(dirPath);
      if (dirInfo) {
        dirInfo.node.status = status;
      }
      setRowStatus(dirPath, status);
    }
    restripe();
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
  document.addEventListener('scroll', closeContextMenu, true);
  window.addEventListener('blur', closeContextMenu);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeContextMenu();
    }
  });

  // 경로를 구분자(/ 또는 \)를 유지한 채 조각으로 나눈다.
  function tokenizePath(p) {
    return p.split(/([\\/]+)/).filter((t) => t.length > 0);
  }

  // 두 경로를 비교해 공통 접두/접미 부분은 그대로, 서로 다른 가운데 부분만
  // 강조 표시(.path-diff)해서 렌더링한다.
  function renderRootName(el, thisPath, otherPath) {
    el.textContent = '';
    const a = tokenizePath(thisPath);
    const b = tokenizePath(otherPath);

    let prefixLen = 0;
    while (
      prefixLen < a.length &&
      prefixLen < b.length &&
      a[prefixLen] === b[prefixLen]
    ) {
      prefixLen++;
    }

    let suffixLen = 0;
    while (
      suffixLen < a.length - prefixLen &&
      suffixLen < b.length - prefixLen &&
      a[a.length - 1 - suffixLen] === b[b.length - 1 - suffixLen]
    ) {
      suffixLen++;
    }

    const prefix = a.slice(0, prefixLen).join('');
    const middle = a.slice(prefixLen, a.length - suffixLen).join('');
    const suffix = a.slice(a.length - suffixLen).join('');

    if (prefix) {
      el.appendChild(document.createTextNode(prefix));
    }
    if (middle) {
      const span = document.createElement('span');
      span.className = 'path-diff';
      span.textContent = middle;
      el.appendChild(span);
    }
    if (suffix) {
      el.appendChild(document.createTextNode(suffix));
    }
  }

  // 한 줄씩 건너뛰며 배경을 다르게 칠해 가독성을 높인다.
  // 접힌 폴더 아래 숨겨진 행은 건너뛰고 화면에 보이는 행만 센다.
  function restripe() {
    const rows = treeEl.querySelectorAll('.row');
    let i = 0;
    for (const row of rows) {
      if (row.offsetParent === null) {
        continue;
      }
      row.classList.toggle('stripe', i % 2 === 1);
      i++;
    }
  }

  // ancestorLines: array of booleans for ancestor guide columns (true = draw
  // vertical line), or null for top-level nodes (no guides). isLast: whether
  // this node is the last among its siblings.
  function renderNode(node, isLast, ancestorLines) {
    const container = document.createElement('div');
    container.className = 'node';
    container.dataset.status = node.status;
    nodeInfo.set(node.relPath, { node, isLast, ancestorLines });
    nodeElements.set(node.relPath, container);

    const hasChildren =
      node.isDirectory && node.children && node.children.length > 0;

    const row = document.createElement('div');
    row.className =
      'row status-' + node.status + ' kind-' + (node.isDirectory ? 'dir' : 'file');
    row.appendChild(renderCell(node, isLast, ancestorLines, 'left', hasChildren));
    row.appendChild(renderGutter(node));
    row.appendChild(renderCell(node, isLast, ancestorLines, 'right', hasChildren));
    container.appendChild(row);

    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      showContextMenu(event.clientX, event.clientY, [
        {
          label: 'Reload',
          action: () => {
            showLoading();
            vscode.postMessage({ type: 'reloadItem', relPath: node.relPath });
          },
        },
      ]);
    });

    if (hasChildren) {
      const childrenEl = document.createElement('div');
      childrenEl.className = 'children';
      // 최상위(root) 항목은 자기 자신의 트위스티 앞에 안내선 칸이 없으므로,
      // 그 자식들에게도 부모용 안내선 칸을 추가하지 않는다. 그래야 각 자식의
      // 커넥터(꺾쇠)가 항상 부모의 트위스티(v) 바로 아래 위치에 오게 된다.
      const childAncestors =
        ancestorLines === null ? [] : ancestorLines.concat(!isLast);
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        const childIsLast = i === node.children.length - 1;
        childrenEl.appendChild(renderNode(child, childIsLast, childAncestors));
      }
      container.appendChild(childrenEl);

      row.addEventListener('click', () => {
        container.classList.toggle('collapsed');
        restripe();
      });
    } else if (!node.isDirectory) {
      row.addEventListener('click', () => {
        if (node.status === 'same' || node.status === 'modified') {
          vscode.postMessage({ type: 'openDiff', relPath: node.relPath });
        } else {
          vscode.postMessage({
            type: 'openFile',
            relPath: node.relPath,
            side: node.status === 'onlyLeft' ? 'left' : 'right',
          });
        }
      });
    }

    return container;
  }

  // 좌우 패널 사이 공간. 좌측에만 있는 항목은 우측으로 복사하는 화살표를 표시한다.
  function renderGutter(node) {
    const gutter = document.createElement('div');
    gutter.className = 'gutter';
    if (node.status === 'onlyLeft') {
      const arrow = document.createElement('span');
      arrow.className = 'copy-arrow';
      arrow.textContent = '→';
      arrow.title = 'Copy to right';
      arrow.addEventListener('click', (event) => {
        event.stopPropagation();
        showLoading();
        vscode.postMessage({ type: 'copyToRight', relPath: node.relPath });
      });
      gutter.appendChild(arrow);
    }
    return gutter;
  }

  function renderCell(node, isLast, ancestorLines, side, hasChildren) {
    const cell = document.createElement('div');
    cell.className = 'cell';

    const existsOnSide =
      node.status === 'same' ||
      node.status === 'modified' ||
      (side === 'left' && node.status === 'onlyLeft') ||
      (side === 'right' && node.status === 'onlyRight');

    if (!existsOnSide) {
      cell.classList.add('empty');
    }

    // Tree guide columns (ancestor vertical lines + this node's elbow connector).
    // 한쪽에만 있는 항목도 반대쪽에 동일한 트리구조선을 그려 자연스럽게 이어지도록 한다.
    if (ancestorLines !== null) {
      for (const drawLine of ancestorLines) {
        const indent = document.createElement('span');
        indent.className = 'guide indent' + (drawLine ? ' line' : '');
        cell.appendChild(indent);
      }
      const connector = document.createElement('span');
      connector.className =
        'guide connector ' +
        (isLast ? 'last' : 'tee') +
        (existsOnSide ? '' : ' noconnect');
      cell.appendChild(connector);
    }

    if (!existsOnSide) {
      return cell;
    }

    const twistie = document.createElement('span');
    twistie.className = 'twistie' + (hasChildren ? ' expandable' : '');
    cell.appendChild(twistie);

    const label = document.createElement('span');
    label.className = 'label' + (node.isDirectory ? ' dir' : '');
    label.textContent = node.name;
    if (!node.isDirectory) {
      if (node.status === 'modified') {
        // 좌우 내용이 다른 파일은 빨간색으로 강조
        label.classList.add('diff');
      } else if (node.status === 'same') {
        // 동일한 파일은 회색으로 옅게 표시하여 상이한 파일이 돋보이게 함
        label.classList.add('same');
      }
    }
    cell.appendChild(label);

    return cell;
  }

  vscode.postMessage({ type: 'ready' });
})();

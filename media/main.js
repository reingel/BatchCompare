// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'init') {
      render(message);
    }
  });

  const reloadBtn = document.getElementById('reload');
  if (reloadBtn) {
    reloadBtn.addEventListener('click', () => {
      reloadBtn.classList.add('spinning');
      vscode.postMessage({ type: 'reload' });
    });
  }

  const swapBtn = document.getElementById('swap');
  if (swapBtn) {
    swapBtn.addEventListener('click', () => {
      swapBtn.classList.add('spinning');
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

  function render(message) {
    if (reloadBtn) {
      reloadBtn.classList.remove('spinning');
    }
    if (swapBtn) {
      swapBtn.classList.remove('spinning');
    }
    const leftName = document.getElementById('left-name');
    const rightName = document.getElementById('right-name');
    renderRootName(leftName, message.leftName, message.rightName);
    leftName.title = message.leftName + '\n(click to change)';
    renderRootName(rightName, message.rightName, message.leftName);
    rightName.title = message.rightName + '\n(click to change)';

    treeEl.textContent = '';
    for (let i = 0; i < message.tree.length; i++) {
      const node = message.tree[i];
      const isLast = i === message.tree.length - 1;
      treeEl.appendChild(renderNode(node, isLast, null));
    }
    // 기본 모드: diff가 있는 경로만 펼쳐서 보여준다.
    expandDiffOnly();
  }

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

    const hasChildren =
      node.isDirectory && node.children && node.children.length > 0;

    const row = document.createElement('div');
    row.className =
      'row status-' + node.status + ' kind-' + (node.isDirectory ? 'dir' : 'file');
    row.appendChild(renderCell(node, isLast, ancestorLines, 'left', hasChildren));
    row.appendChild(renderCell(node, isLast, ancestorLines, 'right', hasChildren));
    container.appendChild(row);

    if (hasChildren) {
      const childrenEl = document.createElement('div');
      childrenEl.className = 'children';
      const childAncestors =
        (ancestorLines === null ? [] : ancestorLines).concat(!isLast);
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
        // 동일한 파일은 확장자별 색상으로 표시
        const color = extColor(node.name);
        if (color) {
          label.style.color = color;
        }
      }
    }
    cell.appendChild(label);

    return cell;
  }

  function hashHue(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = (h * 31 + str.charCodeAt(i)) >>> 0;
    }
    return h % 360;
  }

  function extColor(name) {
    const dot = name.lastIndexOf('.');
    if (dot <= 0) {
      return null; // 확장자 없음 또는 dotfile
    }
    const ext = name.slice(dot + 1).toLowerCase();
    const hue = hashHue(ext);
    const isLight = document.body.classList.contains('vscode-light');
    // 무채색(회색) 계열을 유지하면서 확장자별로 명도만 다르게 하여 구분한다.
    const min = isLight ? 25 : 55;
    const max = isLight ? 55 : 85;
    const lightness = Math.round(min + (hue / 359) * (max - min));
    return 'hsl(0, 0%, ' + lightness + '%)';
  }

  vscode.postMessage({ type: 'ready' });
})();

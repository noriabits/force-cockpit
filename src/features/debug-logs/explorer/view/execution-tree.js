// @ts-check
// Renders the parsed call tree: collapsible nodes with total/self milliseconds
// and a proportional timeline bar, so "where did the time go" is visible at a
// glance. Clicking a node jumps the Pretty view to its log line.

/**
 * @param {{ escapeHtml: (s: string) => string, onJumpToLine: (lineNo: number) => void }} ctx
 */
export function createExecutionTree(ctx) {
  const { escapeHtml } = ctx;

  /** @param {any[]} nodes */
  function maxTotal(nodes) {
    let max = 0;
    const walk = (/** @type {any[]} */ list) => {
      for (const node of list) {
        if (typeof node.totalMs === 'number') max = Math.max(max, node.totalMs);
        walk(node.children);
      }
    };
    walk(nodes);
    return max;
  }

  /**
   * @param {any} node
   * @param {number} scale
   * @param {number} depth
   * @returns {HTMLElement}
   */
  function buildNode(node, scale, depth) {
    const wrapper = document.createElement('div');
    wrapper.className = 'dbg-tree-node';

    const row = document.createElement('div');
    row.className = 'dbg-tree-row';
    row.style.paddingLeft = `${depth * 14}px`;

    const toggle = document.createElement('span');
    toggle.className = 'dbg-tree-toggle';
    toggle.textContent = node.children.length ? '▾' : '·';

    const name = document.createElement('span');
    name.className = `dbg-tree-name dbg-tree-name--${node.kind}`;
    name.innerHTML = escapeHtml(node.name);

    const timing = document.createElement('span');
    timing.className = 'dbg-tree-timing';
    timing.textContent =
      node.totalMs === null ? '—' : `${node.totalMs} ms total · ${node.selfMs ?? 0} ms self`;

    const bar = document.createElement('span');
    bar.className = 'dbg-tree-bar';
    const width = scale > 0 && node.totalMs ? Math.max(2, (node.totalMs / scale) * 100) : 0;
    bar.style.width = `${Math.min(100, width)}%`;

    row.appendChild(toggle);
    row.appendChild(name);
    row.appendChild(bar);
    row.appendChild(timing);
    wrapper.appendChild(row);

    const childrenEl = document.createElement('div');
    childrenEl.className = 'dbg-tree-children';
    // Deep trees start collapsed so the first screen stays readable.
    if (depth >= 2) childrenEl.style.display = 'none';
    if (depth >= 2 && node.children.length) toggle.textContent = '▸';
    for (const child of node.children) {
      childrenEl.appendChild(buildNode(child, scale, depth + 1));
    }
    wrapper.appendChild(childrenEl);

    row.addEventListener('click', (event) => {
      if (/** @type {HTMLElement} */ (event.target) === toggle && node.children.length) {
        const hidden = childrenEl.style.display === 'none';
        childrenEl.style.display = hidden ? '' : 'none';
        toggle.textContent = hidden ? '▾' : '▸';
        return;
      }
      ctx.onJumpToLine(node.lineNo);
    });

    return wrapper;
  }

  return {
    /**
     * @param {HTMLElement} container
     * @param {any[]} tree
     */
    render(container, tree) {
      container.innerHTML = '';
      if (!tree || tree.length === 0) {
        container.innerHTML =
          '<div class="dbg-empty">No execution tree — raise ApexCode to FINE or above to ' +
          'capture method entry and exit events.</div>';
        return;
      }
      const scale = maxTotal(tree);
      for (const node of tree) container.appendChild(buildNode(node, scale, 0));
    },
  };
}

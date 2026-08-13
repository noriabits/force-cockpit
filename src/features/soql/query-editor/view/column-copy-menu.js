// @ts-check
// Copy-format menu for a SOQL results column header.
//
// The panel is appended to <body> and positioned `fixed`, anchored off the
// clicked button's bounding rect. That is load-bearing: .table-wrapper is
// `overflow-x: auto` (which computes overflow-y to `auto` too), so a menu
// positioned inside the <th> would be clipped and would scroll away with the
// table. Same escape hatch media/modules/tooltip.js uses for .fc-tooltip.
import { COLUMN_COPY_FORMATS } from './export-format';

/**
 * @typedef {Object} ColumnCopyMenuCtx
 * @property {(colIndex: number, formatId: import('./export-format').ColumnCopyFormatId, btn: HTMLButtonElement) => void} onPick
 */

/** @param {ColumnCopyMenuCtx} ctx */
export function createColumnCopyMenu(ctx) {
  const { onPick } = ctx;

  /** @type {HTMLElement | null} */
  let panel = null;
  /** @type {HTMLButtonElement | null} */
  let anchorBtn = null;
  let colIndex = -1;

  function ensurePanel() {
    if (panel) return panel;
    const el = document.createElement('div');
    el.className = 'query-col-menu';
    el.style.display = 'none';
    for (const fmt of COLUMN_COPY_FORMATS) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'query-col-menu-item';

      const label = document.createElement('span');
      label.textContent = fmt.label;
      const sample = document.createElement('span');
      sample.className = 'query-col-menu-sample';
      sample.textContent = fmt.sample;

      item.appendChild(label);
      item.appendChild(sample);
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const btn = anchorBtn;
        const idx = colIndex;
        close();
        if (btn && idx >= 0) onPick(idx, fmt.id, btn);
      });
      el.appendChild(item);
    }
    document.body.appendChild(el);
    panel = el;
    return el;
  }

  /** @param {HTMLButtonElement} btn */
  function position(btn) {
    const el = ensurePanel();
    const rect = btn.getBoundingClientRect();
    const menu = el.getBoundingClientRect();
    let top = rect.bottom + 4;
    // Flip above when there is no room below.
    if (top + menu.height > window.innerHeight - 4) {
      top = Math.max(4, rect.top - menu.height - 4);
    }
    let left = rect.left;
    left = Math.max(4, Math.min(left, window.innerWidth - menu.width - 4));
    el.style.top = `${Math.round(top)}px`;
    el.style.left = `${Math.round(left)}px`;
  }

  function close() {
    if (panel) panel.style.display = 'none';
    anchorBtn = null;
    colIndex = -1;
  }

  /**
   * Open the menu for a column, or close it when it is already open on the
   * same button (click-to-toggle).
   * @param {HTMLButtonElement} btn
   * @param {number} index
   */
  function openFor(btn, index) {
    if (anchorBtn === btn) {
      close();
      return;
    }
    const el = ensurePanel();
    anchorBtn = btn;
    colIndex = index;
    el.style.display = 'block';
    position(btn);
  }

  document.addEventListener('click', (e) => {
    if (!anchorBtn) return;
    const target = /** @type {Node | null} */ (e.target);
    if (panel && target && panel.contains(target)) return;
    close();
  });
  document.addEventListener('keydown', (e) => {
    if (anchorBtn && /** @type {KeyboardEvent} */ (e).key === 'Escape') close();
  });
  window.addEventListener('scroll', close, true);
  window.addEventListener('resize', close);

  return { openFor, close };
}

// @ts-check
// Hover-revealed "copy this cell" button for the SOQL results table.
//
// ONE shared button, not one per cell: a full result is 2000 records × ~10
// columns, so a real button in every <td> would add ~20k nodes to every render
// (sort, filter and re-run all rebuild the tbody). Instead a single element is
// appended to <body>, positioned `fixed` off the hovered cell's rect and moved
// around — the same escape hatch column-copy-menu.js and media/modules/tooltip.js
// use to get out of .table-wrapper's overflow clipping.
//
// The icon sits in the left gutter that `#results-table td { padding-left }`
// reserves permanently (view.css), so revealing it shifts nothing and never
// covers the start of the value.
import { copyTextWithFeedback } from '../../../shared/view/output-actions';

/** Gap between the cell's left edge and the button. */
const LEFT_INSET = 3;

/** Cap on how far down a (possibly expanded) cell the button may sit. */
const TOP_INSET = 6;

/**
 * @typedef {Object} CellCopyButtonCtx
 * @property {HTMLElement} tbody
 * @property {HTMLElement | null} wrapper The scrollable .table-wrapper, for the clip guard.
 */

/** @param {CellCopyButtonCtx} ctx */
export function createCellCopyButton(ctx) {
  const { tbody, wrapper } = ctx;

  /** @type {HTMLButtonElement | null} */
  let btn = null;
  /** @type {HTMLElement | null} */
  let currentTd = null;

  function ensureBtn() {
    if (btn) return btn;
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'query-cell-copy';
    el.textContent = '⧉';
    el.style.display = 'none';
    /** @type {any} */ (window).__setTooltip(el, 'Copy value');
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const value = currentTd && currentTd.getAttribute('data-cell-value');
      if (value) copyTextWithFeedback(el, value, '✓');
    });
    el.addEventListener('mouseout', (e) => {
      const related = /** @type {Node | null} */ (/** @type {MouseEvent} */ (e).relatedTarget);
      if (!related || !currentTd || !currentTd.contains(related)) hide();
    });
    document.body.appendChild(el);
    btn = el;
    return el;
  }

  function hide() {
    if (btn) btn.style.display = 'none';
    currentTd = null;
  }

  /**
   * Place the button in the tracked cell's left gutter, or hide it when the cell
   * has been scrolled out from under it (.table-wrapper scrolls horizontally, and
   * a `fixed` element does not travel with it).
   */
  function position() {
    const el = ensureBtn();
    if (!currentTd) return;
    const rect = currentTd.getBoundingClientRect();
    const left = rect.left + LEFT_INSET;
    const size = el.offsetWidth || 16;
    if (wrapper) {
      const clip = wrapper.getBoundingClientRect();
      if (left < clip.left || left + size > clip.right) {
        el.style.display = 'none';
        return;
      }
    }
    el.style.display = 'block';
    el.style.left = `${Math.round(left)}px`;
    // Centred on a normal one-line row, but capped near the top so an expanded
    // cell (many wrapped lines) doesn't park the button halfway down its value.
    const btnHeight = el.offsetHeight || 16;
    const offsetY = Math.min((rect.height - btnHeight) / 2, TOP_INSET);
    el.style.top = `${Math.round(rect.top + offsetY)}px`;
  }

  tbody.addEventListener('mouseover', (e) => {
    const target = /** @type {HTMLElement | null} */ (e.target);
    const td = /** @type {HTMLElement | null} */ (target && target.closest('td'));
    if (!td || td === currentTd) return;
    // results-table.js stores the raw (un-ellipsized) cell value on every
    // non-null cell and leaves it off null ones, so this is both the value to
    // copy and the "is there anything to copy" test.
    if (!td.getAttribute('data-cell-value')) {
      hide();
      return;
    }
    currentTd = td;
    ensureBtn().style.display = 'block';
    position();
  });

  tbody.addEventListener('mouseout', (e) => {
    if (!currentTd) return;
    const related = /** @type {Node | null} */ (/** @type {MouseEvent} */ (e).relatedTarget);
    // The button lives outside the table, so moving the pointer onto it would
    // otherwise read as leaving the cell.
    if (related && (related === btn || currentTd.contains(related))) return;
    hide();
  });

  // Capture phase so scrolls inside .table-wrapper (which don't bubble) are seen.
  // Reposition rather than hide: the pointer may sit still over a cell while the
  // results scroll under it.
  window.addEventListener(
    'scroll',
    () => {
      if (currentTd) position();
    },
    true,
  );
  window.addEventListener('resize', hide);

  return { hide };
}

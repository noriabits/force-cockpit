// @ts-check
// Click-to-expand for result-table cells holding long values.
//
// Both result tables (SOQL results, monitoring dashboard) clamp every cell to a
// single ellipsized line, so one 2000-char long text area value can't stretch
// its column until the table runs off the panel. This is how the full value is
// read back: tag the cells worth expanding while rendering, then toggle the
// wrapped class from one delegated click listener on the table body.
//
// It replaces the hover tooltip the SOQL table used for the same job — a
// tooltip can't be scrolled, selected or copied from, which is exactly what a
// long Description or error Message is wanted for. Styling lives in
// media/main.css (.fc-cell-clamped / .fc-cell-expanded), next to .fc-tooltip.

const CLAMPED_CLASS = 'fc-cell-clamped';
const EXPANDED_CLASS = 'fc-cell-expanded';

/**
 * Tag a cell whose value is too long to fit on one clamped line.
 *
 * A plain length test, not a `scrollWidth > clientWidth` measurement: the latter
 * is exact but forces a layout read per cell on every render, and a table full
 * of long values is the case where that hurts most. Tagging a cell that turns
 * out to fit costs nothing but an unused cursor — the click still toggles the
 * class, it just has nothing to unwrap.
 *
 * @param {HTMLElement} td
 * @param {string | null | undefined} value
 * @param {number} maxChars Chars that fit on one line at this table's own cap.
 */
export function markExpandableCell(td, value, maxChars) {
  // String(): callers narrow `value` through a `value is string` predicate,
  // which leaves it typed `never` in their else branch — a // @ts-check quirk.
  // It also folds null/undefined into the empty string.
  if (String(value ?? '').length > maxChars) td.classList.add(CLAMPED_CLASS);
}

/**
 * Expand/collapse the clamped cell a click landed in.
 * @param {HTMLElement | null} target The click's target.
 * @returns {boolean} true when a cell was toggled.
 */
export function toggleCellExpansion(target) {
  // A click that ends a drag-selection is the user copying the value, not
  // asking to expand it — collapsing the cell under them would drop the
  // selection they just made.
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed) return false;
  const td = target ? target.closest('.' + CLAMPED_CLASS) : null;
  if (!td) return false;
  td.classList.toggle(EXPANDED_CLASS);
  return true;
}

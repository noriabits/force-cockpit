/**
 * Geometry for drag-to-reorder in the query tab bar: given the pills the dragged
 * one could drop against, decide which pill the cursor is over and which side of
 * it the dragged pill belongs on. Pure and DOM-free; tabs.js feeds it
 * getBoundingClientRect results and maps the answer back to a node.
 *
 * The rule is "the pill *under* the cursor", not "the pill nearest the cursor".
 * A nearest-centre search can name a pill the cursor was never over, and since
 * the dragged pill keeps its space in the bar, every reorder reflows the row —
 * so the same stationary cursor resolves to a different winner than it did a
 * moment ago and the pill flip-flops between slots. dragover keeps firing while
 * the pointer sits still, which turns that into a visible blink.
 */

/** The part of a DOMRect this module needs. */
export interface DropRect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export interface DropTarget {
  /** Index into the `rects` array that was passed in. */
  readonly index: number;
  /** True when the dragged pill belongs after that pill, false when before it. */
  readonly after: boolean;
}

/** Distance from `value` to the `[min, max]` band — 0 anywhere inside it. */
function bandDistance(value: number, min: number, max: number): number {
  if (value < min) return min - value;
  if (value > max) return value - max;
  return 0;
}

/** Pills on one row can sit a sub-pixel apart; treat near-ties as the same row. */
const ROW_TOLERANCE = 1;

/**
 * @param rects Candidate pills' viewport rects, in DOM order, *excluding* the
 *   dragged pill — it is not a drop target for itself.
 * @param x @param y Cursor position, viewport coordinates.
 * @returns The pill to reorder against, or null when there is nothing to drop onto.
 */
export function resolveDropTarget(
  rects: readonly DropRect[],
  x: number,
  y: number,
): DropTarget | null {
  if (rects.length === 0) return null;

  // The bar wraps once enough tabs are open (`.query-tab-bar { flex-wrap: wrap }`),
  // so settle the row first: the row under the cursor, or the closest one when the
  // cursor is above or below the bar. Comparing pills across rows in a single
  // distance check is what lets a pill from another row win.
  let nearestRow = Infinity;
  for (const rect of rects)
    nearestRow = Math.min(nearestRow, bandDistance(y, rect.top, rect.bottom));

  // Then the pill within that row: distance to the pill's own edges, so the one
  // actually under the cursor scores 0 and only the gaps between pills (and the
  // space past either end of the row) fall back to a neighbour. Ties keep the
  // leftmost pill, which with `after` below drops the dragged pill into the gap
  // the cursor is in rather than jumping it over the pill on the right.
  let index = -1;
  let best = Infinity;
  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i];
    if (bandDistance(y, rect.top, rect.bottom) > nearestRow + ROW_TOLERANCE) continue;
    const distance = bandDistance(x, rect.left, rect.right);
    if (distance < best) {
      best = distance;
      index = i;
    }
  }
  if (index < 0) return null;

  const rect = rects[index];
  return { index, after: x > (rect.left + rect.right) / 2 };
}

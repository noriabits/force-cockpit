import { describe, expect, it } from 'vitest';
import { resolveDropTarget, type DropRect } from './tab-drop-target';

/** A pill on one row: `[left, right)` at the given row band. */
function pill(left: number, right: number, top = 0, bottom = 20): DropRect {
  return { left, right, top, bottom };
}

/** One row of evenly spaced 100px-wide pills, 2px apart, as the flex gap gives. */
function row(count: number, top = 0): DropRect[] {
  return Array.from({ length: count }, (_, i) => pill(i * 102, i * 102 + 100, top, top + 20));
}

describe('resolveDropTarget', () => {
  it('returns null when there is nothing to drop against', () => {
    expect(resolveDropTarget([], 50, 10)).toBeNull();
  });

  it('drops before the pill when the cursor is left of its midpoint', () => {
    expect(resolveDropTarget(row(3), 120, 10)).toEqual({ index: 1, after: false });
  });

  it('drops after the pill when the cursor is right of its midpoint', () => {
    expect(resolveDropTarget(row(3), 180, 10)).toEqual({ index: 1, after: true });
  });

  it('treats the midpoint itself as before, so the pill only moves past it', () => {
    expect(resolveDropTarget(row(3), 152, 10)).toEqual({ index: 1, after: false });
  });

  it('picks the pill under the cursor, not the one whose centre is nearest', () => {
    // A wide pill either side of a narrow one: at x=205 the cursor is inside the
    // narrow middle pill, but the right pill's centre is closer than the middle
    // pill's. A nearest-centre search would name the wrong pill here.
    const rects = [pill(0, 190), pill(192, 220), pill(222, 600)];
    expect(resolveDropTarget(rects, 205, 10)).toEqual({ index: 1, after: false });
  });

  it('falls back to the nearest pill when the cursor is in the gap between two', () => {
    // Gaps are a couple of px wide; the left pill wins the tie and `after`
    // places the drag in the gap itself rather than jumping it to the right.
    expect(resolveDropTarget(row(3), 101, 10)).toEqual({ index: 0, after: true });
  });

  it('clamps to the first pill when the cursor is left of the whole bar', () => {
    expect(resolveDropTarget(row(3), -40, 10)).toEqual({ index: 0, after: false });
  });

  it('clamps to the last pill when the cursor is right of the whole bar', () => {
    expect(resolveDropTarget(row(3), 900, 10)).toEqual({ index: 2, after: true });
  });

  describe('when the bar has wrapped to several rows', () => {
    const rects = [...row(3, 0), ...row(3, 24)];

    it('targets a pill in the row the cursor is in', () => {
      expect(resolveDropTarget(rects, 120, 30)).toEqual({ index: 4, after: false });
    });

    it('never targets another row, even when a pill there is closer', () => {
      // x=900 is past the end of both rows: the second row's last pill is the
      // only candidate, since the cursor sits in that row's band.
      expect(resolveDropTarget(rects, 900, 30)).toEqual({ index: 5, after: true });
    });

    it('falls back to the nearest row when the cursor is below the bar', () => {
      expect(resolveDropTarget(rects, 120, 200)).toEqual({ index: 4, after: false });
    });

    it('falls back to the nearest row when the cursor is above the bar', () => {
      expect(resolveDropTarget(rects, 120, -50)).toEqual({ index: 1, after: false });
    });
  });
});

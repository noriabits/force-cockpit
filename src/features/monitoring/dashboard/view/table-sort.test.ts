import { describe, it, expect } from 'vitest';
import { filterRows, sortRows } from './table-sort';

const rows = [
  ['Alpha', '30', '001000000000000AAA'],
  ['Bravo', '2', '002000000000000AAA'],
  ['Charlie', '100', '003000000000000AAA'],
];

describe('filterRows', () => {
  it('returns the same array reference for a blank query', () => {
    expect(filterRows(rows, '')).toBe(rows);
    expect(filterRows(rows, '   ')).toBe(rows);
  });

  it('matches case-insensitive substrings across all cells', () => {
    expect(filterRows(rows, 'bravo')).toEqual([rows[1]]);
    expect(filterRows(rows, '00300')).toEqual([rows[2]]);
  });

  it('returns an empty array when nothing matches', () => {
    expect(filterRows(rows, 'zzz')).toEqual([]);
  });

  it('treats null/undefined cells as empty strings', () => {
    expect(
      filterRows(
        [
          ['x', null],
          [undefined, 'y'],
        ],
        'y',
      ),
    ).toEqual([[undefined, 'y']]);
  });
});

describe('sortRows', () => {
  it('returns the input unchanged for a negative sort column', () => {
    expect(sortRows(rows, -1, true)).toBe(rows);
  });

  it('sorts numeric columns numerically, not lexically', () => {
    const sorted = sortRows(rows, 1, true).map((r) => r[1]);
    expect(sorted).toEqual(['2', '30', '100']);
  });

  it('reverses order when ascending is false', () => {
    const sorted = sortRows(rows, 1, false).map((r) => r[1]);
    expect(sorted).toEqual(['100', '30', '2']);
  });

  it('sorts non-numeric columns with a locale string compare', () => {
    const sorted = sortRows(rows, 0, true).map((r) => r[0]);
    expect(sorted).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('does not mutate the input array', () => {
    const copy = [...rows];
    sortRows(rows, 1, true);
    expect(rows).toEqual(copy);
  });
});

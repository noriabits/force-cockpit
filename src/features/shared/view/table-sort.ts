/**
 * Pure helpers for the monitoring table: row filtering and sorting. No DOM
 * access — the DOM layer lives in table-rendering.js. Extracted so the
 * comparator (numeric-aware, with locale string fallback) and the
 * case-insensitive substring filter can be unit-tested directly.
 */

type Cell = string | null;
type Row = Cell[];

/**
 * Keep rows where any cell contains `query` (case-insensitive substring).
 * An empty/blank query returns the input array unchanged (same reference).
 */
export function filterRows(rows: Row[], query: string): Row[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((row) =>
    row.some((c) =>
      String(c == null ? '' : c)
        .toLowerCase()
        .includes(q),
    ),
  );
}

/**
 * Sort rows by the given column. Numeric columns sort numerically; otherwise
 * a locale string compare is used. `sortCol < 0` returns the input unchanged.
 * Returns a new array (never mutates the input) when sorting.
 */
export function sortRows(rows: Row[], sortCol: number, sortAsc: boolean): Row[] {
  if (sortCol < 0) return rows;
  return [...rows].sort((a, b) => {
    const va = a[sortCol] ?? '';
    const vb = b[sortCol] ?? '';
    const na = Number(va);
    const nb = Number(vb);
    if (!isNaN(na) && !isNaN(nb)) return sortAsc ? na - nb : nb - na;
    return sortAsc ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
  });
}

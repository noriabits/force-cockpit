/**
 * Pure formatters for exporting SOQL query results. No DOM, no vscode — the
 * caller passes the current (filtered + sorted) view and gets a string back to
 * hand to the host for writing to disk. Unit-tested in export-format.test.ts.
 */

type Cell = string | null;

/**
 * Escape a single CSV field per RFC 4180: wrap in double quotes when it
 * contains a comma, double-quote, CR or LF; inner double-quotes are doubled.
 */
function escapeCsvField(value: Cell): string {
  const s = value == null ? '' : value;
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Build an RFC-4180 CSV string (header row + data rows, CRLF line endings). */
export function toCsv(cols: string[], rows: Cell[][]): string {
  const lines = [cols.map(escapeCsvField).join(',')];
  for (const row of rows) {
    lines.push(row.map(escapeCsvField).join(','));
  }
  return lines.join('\r\n');
}

// ── Column copy formats ──────────────────────────────────────────────────────
// The `⧉` button on a results column header opens a menu built from
// COLUMN_COPY_FORMATS and copies via formatColumn(). Every format shares the
// same value rule (skip null/empty, dedupe) — only the serialization differs.

export type ColumnCopyFormatId = 'lines' | 'csv' | 'quoted' | 'parens';

/** Menu descriptors, in display order. `sample` is the dimmed example shown next to the label. */
export const COLUMN_COPY_FORMATS: {
  id: ColumnCopyFormatId;
  label: string;
  sample: string;
}[] = [
  { id: 'lines', label: 'One per line', sample: 'a↵b' },
  { id: 'csv', label: 'Comma-separated', sample: 'a,b' },
  { id: 'quoted', label: 'Quoted list', sample: "'a', 'b'" },
  { id: 'parens', label: 'IN-clause', sample: "('a', 'b')" },
];

/** Skip null/empty and dedupe, preserving first-seen order. */
function usableValues(values: Cell[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (v == null || v === '') continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/** Single-quote a value for a SOQL literal: escape backslash first, then the quote. */
function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * Serialize a column's values in the requested shape. Returns '' when no usable
 * values remain — including for `parens`, since an empty `()` is a broken SOQL
 * fragment rather than a useful paste.
 */
export function formatColumn(values: Cell[], format: ColumnCopyFormatId): string {
  const usable = usableValues(values);
  if (usable.length === 0) return '';
  switch (format) {
    case 'lines':
      return usable.join('\n');
    // No space after the comma: this one is consumed by machines (URL query
    // params, CLI flags, a spreadsheet Text-to-Columns split), and plenty of
    // those splitters don't trim. The quoted formats below go into SOQL, where
    // whitespace is free and readability wins.
    case 'csv':
      return usable.join(',');
    case 'quoted':
      return usable.map(quote).join(', ');
    case 'parens':
      return `(${usable.map(quote).join(', ')})`;
  }
}

/** Build a pretty-printed JSON array of `{ col: value }` objects. */
export function toJson(cols: string[], rows: Cell[][]): string {
  const objects = rows.map((row) => {
    const obj: Record<string, Cell> = {};
    cols.forEach((col, i) => {
      obj[col] = row[i] ?? null;
    });
    return obj;
  });
  return JSON.stringify(objects, null, 2);
}

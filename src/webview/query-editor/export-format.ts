/**
 * Pure formatters for exporting Quick Query results. No DOM, no vscode — the
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

/**
 * Build a single-quoted, comma-separated list of a column's values for pasting
 * into a SOQL `IN (...)` clause, e.g. `'a', 'b'`. Skips null/empty, dedupes
 * (first-seen order), and escapes backslash then single-quote (`\\`, `\'`).
 */
export function toQuotedInList(values: Cell[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (v == null || v === '') continue;
    if (seen.has(v)) continue;
    seen.add(v);
    const escaped = v.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    out.push(`'${escaped}'`);
  }
  return out.join(', ');
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

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

// Plain-text search over a raw log body, for the list's "search inside logs".
// Case-insensitive substring, line by line, so a hit can name the line it is on.

/** Longest first-matching line sent back to the webview. */
const MAX_LINE_CHARS = 200;

export interface BodySearchHit {
  /** Matching LINES, not occurrences — what the viewer's own search counts. */
  count: number;
  /** The first matching line, trimmed and capped. */
  firstLine: string;
  /** 1-based, aligned with the viewer's line numbers. */
  firstLineNo: number;
}

/** `null` when the body does not contain `query` (or `query` is blank). */
export function searchBody(body: string, query: string): BodySearchHit | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;
  // Cheap reject before splitting a body that may be megabytes long.
  const haystack = body.toLowerCase();
  if (!haystack.includes(needle)) return null;

  // CRLF: Salesforce serves bodies with \r\n (see logLine.ts).
  const lines = body.split(/\r?\n/);
  let count = 0;
  let firstLineNo = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].toLowerCase().includes(needle)) continue;
    count++;
    if (!firstLineNo) firstLineNo = i + 1;
  }
  const first = lines[firstLineNo - 1].trim();
  return {
    count,
    firstLine: first.length > MAX_LINE_CHARS ? `${first.slice(0, MAX_LINE_CHARS)}…` : first,
    firstLineNo,
  };
}

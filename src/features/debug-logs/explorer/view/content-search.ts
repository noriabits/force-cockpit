// PURE state for "search inside logs": which of the listed logs have been
// scanned, which matched, and what to ask the host for next. DOM-free so the
// batching rules are unit-testable; content-search-bar.js owns the DOM.

/** Logs per round trip — small enough that results appear as they are found. */
export const SEARCH_BATCH_SIZE = 20;

export interface ContentMatch {
  count: number;
  firstLine: string;
  firstLineNo: number;
}

export interface ContentSearch {
  query: string;
  /** The ids listed when the search started, newest first. */
  ids: string[];
  /** How many of `ids` have been sent to the host. */
  cursor: number;
  /** How many of `ids` have come back. */
  scanned: number;
  matches: Map<string, ContentMatch>;
  done: boolean;
  /** Set when a batch failed; the search stops there. */
  error: string | null;
}

export function startSearch(query: string, ids: string[]): ContentSearch {
  return {
    query: query.trim(),
    ids: [...ids],
    cursor: 0,
    scanned: 0,
    matches: new Map(),
    done: ids.length === 0,
    error: null,
  };
}

/** The next ids to scan (advancing the cursor), or `[]` when nothing is left. */
export function nextBatch(search: ContentSearch): string[] {
  if (search.done) return [];
  const batch = search.ids.slice(search.cursor, search.cursor + SEARCH_BATCH_SIZE);
  search.cursor += batch.length;
  return batch;
}

/** Fold one batch's reply in. `batchSize` is how many ids that batch asked about. */
export function applyBatch(
  search: ContentSearch,
  batchSize: number,
  matches: ({ id: string } & ContentMatch)[],
): void {
  for (const { id, count, firstLine, firstLineNo } of matches) {
    search.matches.set(id, { count, firstLine, firstLineNo });
  }
  search.scanned = Math.min(search.ids.length, search.scanned + batchSize);
  if (search.scanned >= search.ids.length) search.done = true;
}

export function failSearch(search: ContentSearch, message: string): void {
  search.error = message;
  search.done = true;
}

/** Listed logs that arrived after the search started and were never scanned. */
export function unsearchedCount(search: ContentSearch, listedIds: string[]): number {
  const scanned = new Set(search.ids);
  return listedIds.filter((id) => !scanned.has(id)).length;
}

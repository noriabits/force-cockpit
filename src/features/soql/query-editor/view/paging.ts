// PURE paging rules for the SOQL results: when another batch exists, how a batch
// folds into what a tab already holds, the row limit, and how the result size is
// described. DOM-free — the DOM side is query-paging.js.

/**
 * A tab never holds more rows than this, however large the result. Batches are
 * fetched automatically up to it; past it, the answer is a narrower query.
 * Enforced by truncation in `mergeBatch`, not just by not asking again, because
 * a batch's size is Salesforce's choice (≤ 2000, smaller for wide rows) and the
 * last one would otherwise overshoot.
 */
export const MAX_LOADED_ROWS = 50_000;

/** The slice of a `queryResult` payload paging reads and writes. */
export interface PagedResult {
  records: unknown[];
  totalSize: number;
  done: boolean;
  nextRecordsUrl?: string;
  /** Why the last batch failed, kept with the rows so a tab switch still shows it. */
  pagingError?: string;
  [key: string]: unknown;
}

/** True when another batch exists. A `SELECT COUNT()` is `done` with no rows. */
export function canLoadMore(result: PagedResult | null | undefined): boolean {
  return !!result && !result.done && !!result.nextRecordsUrl;
}

/** True once a tab holds as many rows as it is ever allowed to. */
export function reachedRowLimit(result: PagedResult, limit = MAX_LOADED_ROWS): boolean {
  return result.records.length >= limit;
}

/** Whether to ask for the batch after this one. */
export function shouldFetchNext(result: PagedResult, limit = MAX_LOADED_ROWS): boolean {
  return canLoadMore(result) && !reachedRowLimit(result, limit);
}

/**
 * Append one batch, truncated to the row limit. Everything else on `prev` — the
 * echoed `soql` and `useToolingApi` the AI panel reads — is kept, and
 * `totalSize` stays the first batch's: it is the real size of the whole
 * result. A successful batch clears any earlier paging error.
 */
export function mergeBatch(
  prev: PagedResult,
  batch: { records?: unknown[]; done: boolean; nextRecordsUrl?: string },
  limit = MAX_LOADED_ROWS,
): PagedResult {
  const rest = { ...prev };
  delete rest.pagingError;
  delete rest.nextRecordsUrl;
  return {
    ...rest,
    records: prev.records.concat(batch.records ?? []).slice(0, limit),
    done: batch.done,
    ...(batch.nextRecordsUrl ? { nextRecordsUrl: batch.nextRecordsUrl } : {}),
  };
}

const fmt = (n: number) => n.toLocaleString('en-US');

/**
 * The results meta line. Says outright when the rows on screen are not the
 * whole result — export and the column copy act on what is loaded, so a
 * partial set must never read as a complete one.
 */
export function describeResultSize(result: PagedResult): string {
  const loaded = result.records.length;
  const { totalSize } = result;
  const noun = totalSize === 1 ? 'record' : 'records';
  if (!canLoadMore(result)) return `${fmt(totalSize)} ${noun}`;
  const partial = `Showing ${fmt(loaded)} of ${fmt(totalSize)} ${noun}`;
  return reachedRowLimit(result)
    ? `${partial} — stopped at the ${fmt(MAX_LOADED_ROWS)}-row limit; narrow the query to see the rest`
    : partial;
}

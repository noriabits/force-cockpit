import type { ConnectionManager } from '../../../salesforce/connection';
import { raceAbort, throwIfAborted } from '../../../utils/abort';

export interface QueryResult {
  records: Record<string, unknown>[];
  totalSize: number;
  done: boolean;
  /** Set only while `done` is false: the locator `queryMore` follows to the next batch. */
  nextRecordsUrl?: string;
}

interface RawQueryResult {
  records: unknown[];
  totalSize: number;
  done: boolean;
  nextRecordsUrl?: string;
}

function toQueryResult(result: RawQueryResult): QueryResult {
  return {
    records: result.records as Record<string, unknown>[],
    totalSize: result.totalSize,
    done: result.done,
    ...(result.nextRecordsUrl ? { nextRecordsUrl: result.nextRecordsUrl } : {}),
  };
}

export class QueryService {
  constructor(private readonly connectionManager: ConnectionManager) {}

  /**
   * `signal` stops the *caller* waiting, not the request: jsforce's `query()` takes no
   * AbortSignal, so an aborted run rejects with 'Operation cancelled' and the HTTP
   * response is left to settle and be discarded — same trade-off the AI paths make.
   *
   * Returns the FIRST batch only (Salesforce caps one at 2000 rows). A larger
   * result comes back `done: false` with a `nextRecordsUrl` for `queryMore`.
   */
  async runQuery(soql: string, useToolingApi = false, signal?: AbortSignal): Promise<QueryResult> {
    throwIfAborted(signal);
    const result = await raceAbort(
      useToolingApi
        ? this.connectionManager.toolingQuery(soql)
        : this.connectionManager.query(soql),
      signal,
    );
    return toQueryResult(result);
  }

  /**
   * One more batch of a partial result. Deliberately one batch per call: the
   * webview drives "Fetch all" as a series of these, so each batch crosses
   * postMessage on its own (never one 50k-row reply), lands in the tab that
   * asked for it, and a cancel between batches simply stops asking.
   */
  async queryMore(
    locator: string,
    useToolingApi = false,
    signal?: AbortSignal,
  ): Promise<QueryResult> {
    throwIfAborted(signal);
    const result = await raceAbort(
      this.connectionManager.queryMore(locator, useToolingApi),
      signal,
    );
    return toQueryResult(result);
  }
}

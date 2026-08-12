import type { ConnectionManager } from '../../salesforce/connection';
import { raceAbort, throwIfAborted } from '../../utils/abort';

export interface QueryResult {
  records: Record<string, unknown>[];
  totalSize: number;
  done: boolean;
}

export class QueryService {
  constructor(private readonly connectionManager: ConnectionManager) {}

  /**
   * `signal` stops the *caller* waiting, not the request: jsforce's `query()` takes no
   * AbortSignal, so an aborted run rejects with 'Operation cancelled' and the HTTP
   * response is left to settle and be discarded — same trade-off the AI paths make.
   */
  async runQuery(soql: string, useToolingApi = false, signal?: AbortSignal): Promise<QueryResult> {
    throwIfAborted(signal);
    const result = await raceAbort(
      useToolingApi
        ? this.connectionManager.toolingQuery(soql)
        : this.connectionManager.query(soql),
      signal,
    );
    return {
      records: result.records as Record<string, unknown>[],
      totalSize: result.totalSize,
      done: result.done,
    };
  }
}

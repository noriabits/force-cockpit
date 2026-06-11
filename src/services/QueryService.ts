import type { ConnectionManager } from '../salesforce/connection';

export interface QueryResult {
  records: Record<string, unknown>[];
  totalSize: number;
  done: boolean;
}

export class QueryService {
  constructor(private readonly connectionManager: ConnectionManager) {}

  async runQuery(soql: string, useToolingApi = false): Promise<QueryResult> {
    const result = useToolingApi
      ? await this.connectionManager.toolingQuery(soql)
      : await this.connectionManager.query(soql);
    return {
      records: result.records as Record<string, unknown>[],
      totalSize: result.totalSize,
      done: result.done,
    };
  }
}

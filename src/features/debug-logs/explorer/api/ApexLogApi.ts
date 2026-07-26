// ApexLog reads/deletes. The list is a plain Tooling SOQL query; the body is a
// plain-text sub-resource (`ApexLog/{id}/Body`) that only the raw REST path can
// return.
import type { ApexLogRow } from '../types';
import { ToolingRest } from './ToolingRest';

const LIST_LIMIT = 200;

interface RawApexLog extends Record<string, unknown> {
  Id: string;
  LogUserId: string;
  LogUser?: { Name?: string } | null;
  Operation: string | null;
  Application: string | null;
  Status: string | null;
  Request: string | null;
  DurationMilliseconds: number | null;
  LogLength: number | null;
  StartTime: string;
}

function toRow(raw: RawApexLog): ApexLogRow {
  return {
    id: raw.Id,
    logUserId: raw.LogUserId,
    logUserName: raw.LogUser?.Name ?? '',
    operation: raw.Operation ?? '',
    application: raw.Application ?? '',
    status: raw.Status ?? '',
    request: raw.Request ?? '',
    durationMilliseconds: raw.DurationMilliseconds ?? 0,
    logLength: raw.LogLength ?? 0,
    startTime: raw.StartTime,
  };
}

export class ApexLogApi {
  constructor(private readonly rest: ToolingRest) {}

  async listLogs(limit = LIST_LIMIT): Promise<ApexLogRow[]> {
    const records = await this.rest.query<RawApexLog>(
      'SELECT Id, LogUserId, LogUser.Name, Operation, Application, Status, Request, ' +
        'DurationMilliseconds, LogLength, StartTime FROM ApexLog ' +
        `ORDER BY StartTime DESC LIMIT ${Math.max(1, Math.min(limit, 1000))}`,
    );
    return records.map(toRow);
  }

  async getBody(logId: string): Promise<string> {
    return this.rest.getText(`sobjects/ApexLog/${logId}/Body`);
  }

  /** Deletes logs one by one (the Tooling API has no bulk delete for ApexLog). */
  async deleteLogs(logIds: string[]): Promise<{ deleted: number; failed: number }> {
    let deleted = 0;
    let failed = 0;
    for (const id of logIds) {
      try {
        await this.rest.remove('ApexLog', id);
        deleted++;
      } catch {
        failed++;
      }
    }
    return { deleted, failed };
  }
}

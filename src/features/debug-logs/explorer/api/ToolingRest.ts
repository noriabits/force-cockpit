// Thin typed wrapper over the Tooling REST API. Reads go through
// ConnectionManager.toolingQuery (jsforce); writes and raw-text reads go
// through ConnectionManager.request, which exposes the HTTP status jsforce
// hides — a non-2xx there is a normal result, so we translate it into an Error
// carrying Salesforce's own message.
import type { ConnectionManager } from '../../../../salesforce/connection';

/** Salesforce REST errors come back as `[{ message, errorCode }]`. */
function describeHttpError(status: number, statusText: string, body: unknown): string {
  if (Array.isArray(body) && body.length > 0) {
    const parts = body
      .map((e) => {
        const entry = e as { message?: string; errorCode?: string };
        return entry.errorCode ? `${entry.errorCode}: ${entry.message ?? ''}` : entry.message;
      })
      .filter(Boolean);
    if (parts.length) return parts.join('; ');
  }
  if (typeof body === 'string' && body.trim()) return body.trim();
  return `HTTP ${status} ${statusText}`;
}

export class ToolingRest {
  constructor(private readonly connectionManager: ConnectionManager) {}

  private get base(): string {
    return `/services/data/v${this.connectionManager.apiVersion}/tooling`;
  }

  /**
   * The standard (non-Tooling) API base. Only `removeMultiple` uses this —
   * see its comment for why.
   */
  private get standardBase(): string {
    return `/services/data/v${this.connectionManager.apiVersion}`;
  }

  /** SOQL against the Tooling API (TraceFlag, DebugLevel, ApexLog, ApexClass…). */
  async query<T extends Record<string, unknown>>(soql: string): Promise<T[]> {
    const result = await this.connectionManager.toolingQuery<T>(soql);
    return result.records ?? [];
  }

  /**
   * SOQL against the standard Data API. Required for `User`: the Tooling API
   * exposes only a cut-down User object without `UserType`, `IsActive` and
   * friends, so querying it there fails with "No such column".
   */
  async queryData<T extends Record<string, unknown>>(soql: string): Promise<T[]> {
    const result = await this.connectionManager.query<T>(soql);
    return result.records ?? [];
  }

  /** POST a new record; resolves with its id. */
  async create(sobject: string, body: Record<string, unknown>): Promise<string> {
    const res = await this.connectionManager.request({
      method: 'POST',
      url: `${this.base}/sobjects/${sobject}`,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(describeHttpError(res.status, res.statusText, res.body));
    }
    return (res.body as { id?: string })?.id ?? '';
  }

  /** PATCH an existing record. */
  async update(sobject: string, id: string, body: Record<string, unknown>): Promise<void> {
    const res = await this.connectionManager.request({
      method: 'PATCH',
      url: `${this.base}/sobjects/${sobject}/${id}`,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(describeHttpError(res.status, res.statusText, res.body));
    }
  }

  /** DELETE a record. A 404 is treated as already gone. */
  async remove(sobject: string, id: string): Promise<void> {
    const res = await this.connectionManager.request({
      method: 'DELETE',
      url: `${this.base}/sobjects/${sobject}/${id}`,
    });
    if (res.status === 404) return;
    if (res.status < 200 || res.status >= 300) {
      throw new Error(describeHttpError(res.status, res.statusText, res.body));
    }
  }

  /**
   * DELETE up to 200 records in one round-trip via the sObject Collections
   * endpoint. **Deliberately hits `standardBase`, not `base`** — there is no
   * Tooling API equivalent of this endpoint (`{base}/composite/sobjects`
   * 404s: verified against a live org, not assumed from docs). The standard
   * Collections endpoint accepts ApexLog ids anyway, even though ApexLog
   * rejects the standard API everywhere else (single delete, query). `ids` must not
   * exceed 200 (the platform's own cap); callers chunk larger lists
   * themselves. An already-gone id comes back `success: false` with
   * `INVALID_CROSS_REFERENCE_KEY` rather than 404ing the whole request (this
   * endpoint has no per-request not-found status), so that one error code is
   * folded into a success here — the same "already gone counts as deleted"
   * idempotency `remove()` gives a 404.
   */
  async removeMultiple(
    ids: string[],
  ): Promise<Array<{ id: string; success: boolean; errors: unknown[] }>> {
    const res = await this.connectionManager.request({
      method: 'DELETE',
      url: `${this.standardBase}/composite/sobjects?ids=${ids.join(',')}`,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(describeHttpError(res.status, res.statusText, res.body));
    }
    const results =
      (res.body as Array<{
        id: string;
        success: boolean;
        errors: Array<{ statusCode?: string }>;
      }>) ?? [];
    return results.map((r) =>
      r.success || r.errors.some((e) => e.statusCode === 'INVALID_CROSS_REFERENCE_KEY')
        ? { ...r, success: true }
        : r,
    );
  }

  /** GET a plain-text sub-resource, e.g. `ApexLog/{id}/Body`. */
  async getText(subPath: string): Promise<string> {
    const res = await this.connectionManager.request({
      method: 'GET',
      url: `${this.base}/${subPath}`,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(describeHttpError(res.status, res.statusText, res.body));
    }
    return typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
  }
}

/** Escape a value for safe interpolation into a SOQL string literal. */
export function soqlEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

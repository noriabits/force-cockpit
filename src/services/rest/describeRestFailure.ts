import type { RestCallResult } from './RestCallService';

/**
 * Salesforce reports errors as `[{ message, errorCode }]`. Surfacing that message
 * verbatim is the difference between "Request failed: 400 Bad Request" and
 * "REQUIRED_FIELD_MISSING: Required fields are missing: [Name]".
 *
 * Shared by the `rest` script executor and the Record Detail's save — both
 * treat a non-2xx as a failure the user must be able to read.
 */
export function describeRestFailure(result: RestCallResult): string {
  const status = `${result.status} ${result.statusText}`.trim();
  const first = Array.isArray(result.body) ? result.body[0] : result.body;
  if (first && typeof first === 'object') {
    const record = first as Record<string, unknown>;
    const message = typeof record.message === 'string' ? record.message : '';
    const code = typeof record.errorCode === 'string' ? record.errorCode : '';
    if (message) return code ? `${status} — ${code}: ${message}` : `${status} — ${message}`;
  }
  return `Request failed: ${status}`;
}

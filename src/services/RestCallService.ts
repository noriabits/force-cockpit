import type { ConnectionManager, HttpMethod } from '../salesforce/connection';

export interface HeaderEntry {
  key: string;
  value: string;
}

export interface RestCallResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** The parsed response body (object for JSON responses, string otherwise, undefined for 204). */
  body: unknown;
}

const VALID_METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/** HTTP methods that carry a request body. */
const BODY_METHODS = new Set<HttpMethod>(['POST', 'PUT', 'PATCH']);

/**
 * Sends an arbitrary REST / Apex REST request against the connected org, reusing the
 * extension's authenticated connection. A default JSON Content-Type is applied, but any
 * user-supplied header (including Content-Type) overrides it. A non-2xx response is
 * returned like any other response (status/headers/body) rather than thrown — only
 * network-level failures propagate as errors.
 */
export class RestCallService {
  constructor(private readonly connectionManager: ConnectionManager) {}

  async send(
    method: string,
    endpoint: string,
    body: string,
    headers: HeaderEntry[] = [],
  ): Promise<RestCallResult> {
    const verb = this.normalizeMethod(method);
    const url = this.normalizeEndpoint(endpoint);

    const options: {
      method: HttpMethod;
      url: string;
      headers: Record<string, string>;
      body?: string;
    } = {
      method: verb,
      url,
      headers: this.mergeHeaders(headers),
    };

    const trimmedBody = body?.trim();
    if (BODY_METHODS.has(verb) && trimmedBody) {
      options.body = body;
    }

    return this.connectionManager.request(options);
  }

  /** Default JSON Content-Type, overridden case-insensitively by any user-supplied header. */
  private mergeHeaders(headers: HeaderEntry[]): Record<string, string> {
    const merged: Record<string, string> = { 'Content-Type': 'application/json' };
    for (const { key, value } of headers) {
      const trimmedKey = key?.trim();
      if (!trimmedKey) continue;
      const existingKey = Object.keys(merged).find(
        (k) => k.toLowerCase() === trimmedKey.toLowerCase(),
      );
      if (existingKey) delete merged[existingKey];
      merged[trimmedKey] = value ?? '';
    }
    return merged;
  }

  /** Uppercases and validates the method, defaulting to GET for anything unrecognized. */
  private normalizeMethod(method: string): HttpMethod {
    const verb = (method || 'GET').toUpperCase() as HttpMethod;
    return VALID_METHODS.includes(verb) ? verb : 'GET';
  }

  /** Trims and ensures a single leading slash for relative paths; leaves absolute URLs untouched. */
  private normalizeEndpoint(endpoint: string): string {
    const trimmed = (endpoint ?? '').trim();
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    return '/' + trimmed.replace(/^\/+/, '');
  }
}

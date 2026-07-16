import type { ConnectionManager, HttpMethod } from '../salesforce/connection';

export interface RestCallResult {
  /** The parsed response body (object for JSON responses, string otherwise, undefined for 204). */
  body: unknown;
}

const VALID_METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/** HTTP methods that carry a request body. */
const BODY_METHODS = new Set<HttpMethod>(['POST', 'PUT', 'PATCH']);

/**
 * Sends an arbitrary REST / Apex REST request against the connected org, reusing the
 * extension's authenticated jsforce connection. jsforce prefixes the instance URL and
 * attaches the Bearer token; we only add a default JSON Content-Type.
 *
 * jsforce's `request()` resolves with the parsed body only (no HTTP status), so on a
 * non-2xx response it throws — MessageRouter turns that into a `restCallError` message.
 */
export class RestCallService {
  constructor(private readonly connectionManager: ConnectionManager) {}

  async send(method: string, endpoint: string, body: string): Promise<RestCallResult> {
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
      headers: { 'Content-Type': 'application/json' },
    };

    const trimmedBody = body?.trim();
    if (BODY_METHODS.has(verb) && trimmedBody) {
      options.body = body;
    }

    const result = await this.connectionManager.request(options);
    return { body: result };
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

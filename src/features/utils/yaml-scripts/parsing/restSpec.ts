import type { HttpMethod } from '../../../../salesforce/connection';
import { isHttpMethod, VALID_METHODS } from '../../../../services/rest/RestCallService';
import type { RestSpec } from '../types';

/**
 * Everything that knows the shape of a `rest:` block, kept pure and free of the
 * invalid-script-card machinery so it can be tested on its own — the same split
 * `workspaceFile.ts` and `execution/thenCondition.ts` already use. `ScriptParser`
 * turns an `{ error }` into the card the UI renders.
 */

/** The raw block as YAML hands it over — every field still unknown. */
export type ParsedRest = {
  method?: unknown;
  endpoint?: unknown;
  headers?: unknown;
  body?: unknown;
  'body-file'?: unknown;
};

/**
 * True when the document declares a `rest:` key at all — including a bare
 * `rest:` that YAML parses as null. Type detection and the "exactly one script
 * field" check both key off declaration, not off the block's contents.
 */
export function hasRestKey(parsed: object): boolean {
  return Object.prototype.hasOwnProperty.call(parsed, 'rest');
}

/**
 * The `body-file` path, when the block names a usable one. A rest script stores
 * its body in the ordinary `script`/`scriptFile` fields, so this is what tells
 * `detectScriptKind` whether the script is file-backed.
 */
export function restBodyFile(raw: ParsedRest | undefined): string | undefined {
  const bodyFile = raw?.['body-file'];
  return typeof bodyFile === 'string' && bodyFile.trim() ? bodyFile : undefined;
}

/**
 * The inline body. A rest script's body is optional (GET/DELETE carry none), so
 * an absent one is an empty string rather than a missing script field. A
 * non-string body never reaches here — `parseRestSpec` rejects it first.
 */
export function restBody(raw: ParsedRest | undefined): string {
  const body = raw?.body;
  return typeof body === 'string' ? body : '';
}

/**
 * Validates the `rest:` block and builds the request line. Every failure is
 * reported rather than silently repaired: `RestCallService` downgrades an
 * unrecognized verb to GET, which is acceptable in the REST tab (the user sees
 * the result at once) but would make a saved script lie about what it does.
 *
 * Guard order is load-bearing — `ScriptParser.test.ts` pins which error a file
 * with more than one problem reports.
 */
export function parseRestSpec(raw: unknown): { rest: RestSpec } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: "'rest' must be an object with at least a 'method' and an 'endpoint'" };
  }
  const r = raw as ParsedRest;

  if (r.body != null && r['body-file'] != null) {
    return { error: "'rest' is ambiguous: set either 'body' or 'body-file', not both" };
  }

  // `body: {"Name": "Acme"}` is a YAML flow *mapping*, not a string. Left
  // unchecked it coerces to '' and the request goes out with no body at all —
  // a POST then fails confusingly and a PATCH returns 204 having changed
  // nothing, both from a file that looks correct.
  if (r.body != null && typeof r.body !== 'string') {
    return { error: "'rest.body' must be a string — use a '|' block for a JSON body" };
  }

  const endpoint = typeof r.endpoint === 'string' ? r.endpoint.trim() : '';
  if (!endpoint) {
    return { error: "'rest' is missing required field: 'endpoint'" };
  }

  if (r.method != null && typeof r.method !== 'string') {
    return { error: "'rest.method' must be one of " + VALID_METHODS.join(', ') };
  }
  const rawMethod = typeof r.method === 'string' ? r.method.trim() : '';
  // Default GET, matching the REST tab's own default for an untouched request.
  const method = rawMethod === '' ? 'GET' : rawMethod;
  if (!isHttpMethod(method)) {
    return {
      error: `Unsupported 'rest.method': ${method} (use one of ${VALID_METHODS.join(', ')})`,
    };
  }

  const headers = parseRestHeaders(r.headers);
  if (headers === null) {
    return { error: "'rest.headers' must be a map of header names to string values" };
  }

  return {
    rest: {
      method: method.toUpperCase() as HttpMethod,
      endpoint,
      ...(Object.keys(headers).length ? { headers } : {}),
    },
  };
}

/** `null` signals a malformed block; `{}` an absent or empty one. */
function parseRestHeaders(raw: unknown): Record<string, string> | null {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const name = key.trim();
    if (!name) continue;
    // Numbers and booleans are what an unquoted YAML scalar becomes, and a
    // header value is a string either way — coerce rather than reject.
    if (typeof value === 'object' && value !== null) return null;
    headers[name] = value == null ? '' : String(value);
  }
  return headers;
}

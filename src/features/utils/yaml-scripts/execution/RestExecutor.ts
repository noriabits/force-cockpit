import type {
  HeaderEntry,
  RestCallResult,
  RestCallService,
} from '../../../../services/rest/RestCallService';
import { throwIfAborted } from '../../../../utils/abort';
import type { ExecuteScriptResult, YamlScript } from '../types';

/** Values a response body can contribute as a chaining output. */
type Scalar = string | number | boolean;

function isScalar(value: unknown): value is Scalar {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * Runs a `rest` script: one REST / Apex REST request against the connected org.
 *
 * Delegates to `RestCallService`, so header merging, endpoint normalization, the
 * body-drop on GET and the 401 session-refresh replay all behave exactly as they
 * do in the REST tab. The one deliberate divergence is the verdict: the REST tab
 * renders a non-2xx as a normal result, but a script must FAIL on one so a `then:`
 * chain stops instead of handing a 404 to the next step.
 */
export class RestExecutor {
  constructor(private readonly restCallService: RestCallService) {}

  async execute(
    script: YamlScript,
    signal?: AbortSignal,
    onLogChunk?: (chunk: string) => void,
  ): Promise<ExecuteScriptResult> {
    const rest = script.rest;
    if (!rest) {
      return {
        scriptId: script.id,
        success: false,
        message: `Script "${script.name}" has no 'rest' request configured.`,
        debugLog: '',
      };
    }

    const log: string[] = [];
    const emit = (line: string) => {
      log.push(line);
      onLogChunk?.(line + '\n');
    };

    emit(`${rest.method} ${rest.endpoint}`);

    try {
      throwIfAborted(signal);
      const result = await this.restCallService.send(
        rest.method,
        rest.endpoint,
        script.script,
        toHeaderEntries(rest.headers),
        signal,
      );
      // `send` resolves normally on abort only if the request had already
      // completed; the fetch itself rejects. Either way a cancelled run must not
      // report a result.
      throwIfAborted(signal);

      this.emitResponse(emit, result);

      const success = result.status >= 200 && result.status < 300;
      return {
        scriptId: script.id,
        success,
        message: success
          ? `Request "${script.name}" returned ${result.status} ${result.statusText}.`
          : describeFailure(result),
        debugLog: log.join('\n'),
        outputs: buildOutputs(result),
      };
    } catch (err) {
      const message = (err as Error).message;
      // A fetch aborted in flight rejects with an AbortError ("This operation was
      // aborted") straight from `ConnectionManager.rawFetch` — it never carries the
      // shared 'Operation cancelled' sentinel, so the signal itself is the test.
      // Without this, a cancelled rest step inside a `then:` chain would be reported
      // as a genuine failure, since `runThenChain` tells the two apart by that string.
      if (signal?.aborted || message === 'Operation cancelled') {
        return { scriptId: script.id, success: false, message: '', debugLog: '', cancelled: true };
      }
      // Only network-level failures reach here — RestCallService returns any HTTP
      // status as a normal result.
      emit(`\n--- error ---\n${message}`);
      return { scriptId: script.id, success: false, message, debugLog: log.join('\n') };
    }
  }

  private emitResponse(emit: (line: string) => void, result: RestCallResult): void {
    const refreshed = result.sessionRefreshed ? ' · session refreshed' : '';
    emit(`${result.status} ${result.statusText}${refreshed}`);

    const headerLines = Object.entries(result.headers).map(([k, v]) => `  ${k}: ${v}`);
    if (headerLines.length) {
      emit('');
      emit('Response headers:');
      headerLines.forEach(emit);
    }

    emit('');
    emit(formatBody(result.body));
  }
}

function toHeaderEntries(headers: Record<string, string> | undefined): HeaderEntry[] {
  return Object.entries(headers ?? {}).map(([key, value]) => ({ key, value }));
}

/**
 * The body is pretty-printed so the log viewer's Format-JSON rendering has a
 * parseable block to turn into a table.
 */
function formatBody(body: unknown): string {
  if (body == null) return '(no response body)';
  if (typeof body === 'string') return body;
  try {
    return JSON.stringify(body, null, 2);
  } catch {
    return String(body);
  }
}

/**
 * Salesforce reports errors as `[{ message, errorCode }]`. Surfacing that message
 * verbatim is the difference between "Request failed: 400 Bad Request" and
 * "REQUIRED_FIELD_MISSING: Required fields are missing: [Name]".
 */
function describeFailure(result: RestCallResult): string {
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

/**
 * What the script hands to `then:` / `runScript()`. `status` is always present;
 * a JSON object body also contributes each of its top-level scalars, so a
 * Salesforce create response yields `${id}` and `${success}` with no follow-up
 * parsing step. Nested objects and arrays are skipped — a `then: with:` value is
 * a string, and a serialized blob is not something a callee can use.
 *
 * `status` deliberately wins a collision with a body field of the same name: it
 * is the one output every rest script is documented to publish, and silently
 * shadowing it would break chains for no visible reason.
 */
function buildOutputs(result: RestCallResult): Record<string, string> {
  const outputs: Record<string, string> = {};
  const body = result.body;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (isScalar(value)) outputs[key] = String(value);
    }
  }
  outputs.status = String(result.status);
  return outputs;
}

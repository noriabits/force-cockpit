// The log-list "hide empty logs" filter.
//
// A real org fills the log list with Lightning/Aura round-trips, heartbeat REST
// calls and no-op triggers that contain nothing worth reading. "Empty" means
// *the transaction did nothing observable*, which can only be decided from the
// body — so `isEmptyByContent` is the real test and `isEmptyByMetadata` is only
// a free pre-filter for requests we can recognise by name.
//
// Size and duration are deliberately NOT used by default: anonymous Apex logs
// are naturally small and fast (a useful log with five debug lines and a query
// is ~1.5 KB / 8 ms), so treating "small" as "empty" hides exactly the logs the
// user came for. The thresholds remain configurable for anyone who wants that
// cheap pre-filter, but 0 (the default) disables them.
import type { ApexLogRow, NoiseOptions } from '../types';

export const DEFAULT_NOISE_OPTIONS: NoiseOptions = {
  maxEmptyBytes: 0,
  maxEmptyDurationMs: 0,
  operationPatterns: ['/aura', 'aura.', 'VFRemoting', 'Lightning', 'PushTopic', 'ApexRestApi'],
};

export function resolveNoiseOptions(overrides?: Partial<NoiseOptions>): NoiseOptions {
  return {
    maxEmptyBytes: overrides?.maxEmptyBytes ?? DEFAULT_NOISE_OPTIONS.maxEmptyBytes,
    maxEmptyDurationMs: overrides?.maxEmptyDurationMs ?? DEFAULT_NOISE_OPTIONS.maxEmptyDurationMs,
    operationPatterns: overrides?.operationPatterns?.length
      ? overrides.operationPatterns
      : DEFAULT_NOISE_OPTIONS.operationPatterns,
  };
}

/**
 * The free pre-filter, decided from the list row alone. By default this only
 * matches the operation-name patterns (UI/heartbeat chatter); the size and
 * duration rules are off unless configured. A failed log is never noise,
 * however small — the failure is the point.
 */
export function isEmptyByMetadata(row: ApexLogRow, options: NoiseOptions): boolean {
  if (row.status && row.status !== 'Success') return false;
  if (options.maxEmptyBytes > 0 && row.logLength > 0 && row.logLength <= options.maxEmptyBytes) {
    return true;
  }
  if (
    options.maxEmptyDurationMs > 0 &&
    row.durationMilliseconds > 0 &&
    row.durationMilliseconds <= options.maxEmptyDurationMs
  ) {
    return true;
  }
  const operation = row.operation.toLowerCase();
  return options.operationPatterns.some((p) => p && operation.includes(p.toLowerCase()));
}

/**
 * The real test: the transaction did nothing observable — no debug output, no
 * error, no query and no DML. Needs the body, so callers fetch lazily and cache.
 */
export function isEmptyByContent(body: string): boolean {
  if (!body) return true;
  const MEANINGFUL = [
    '|USER_DEBUG|',
    '|FATAL_ERROR|',
    '|EXCEPTION_THROWN|',
    '|SOQL_EXECUTE_BEGIN|',
    '|SOSL_EXECUTE_BEGIN|',
    '|DML_BEGIN|',
    '|CALLOUT_REQUEST|',
    '|VALIDATION_FAIL|',
  ];
  return !MEANINGFUL.some((marker) => body.includes(marker));
}

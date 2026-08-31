// Builds the "what actually happened" summary of a log: governor-limit usage,
// statement counts, the slowest code units and every exception, so the viewer
// (and the AI digest) can lead with the facts instead of 200k raw lines.
import type { CodeUnitTiming, LimitUsage, LogEvent, LogSummary } from '../types';
import { buildExecutionTree, flattenTimings } from './executionTree';
import { isTruncated, sourceLineOf } from './logLine';

/**
 * `  Number of SOQL queries: 3 out of 100` inside a LIMIT_USAGE_FOR_NS block.
 * Salesforce appends a ` ******* CLOSE TO LIMIT` marker to lines near/at the
 * threshold — no trailing anchor here, or exactly the lines this feature
 * exists to catch fail to match.
 */
const LIMIT_RE = /^\s{1,}(.+?):\s+(\d+)\s+out of\s+(\d+)\b/;
/** `|SOQL_EXECUTE_END|[12]|Rows:20` */
const ROWS_RE = /^Rows:(\d+)$/;

/**
 * The FOR_NS block's wording for the `LIMIT_USAGE` codes it also reports,
 * plus the schema-describe and workflow limits that only ever appear as
 * `LIMIT_USAGE` (Salesforce doesn't fold these into the FOR_NS block, so
 * there is no "official" string to match — these are named after what each
 * one actually counts, per the matching `Limits.getX()` Apex method).
 */
const LIMIT_TYPE_LABELS: Partial<Record<string, string>> = {
  SOQL: 'Number of SOQL queries',
  SOQL_ROWS: 'Number of query rows',
  AGGS: 'Number of aggregate queries',
  SOSL: 'Number of SOSL queries',
  DML_STATEMENTS: 'Number of DML statements',
  DML_ROWS: 'Number of DML rows',
  CPU_TIME: 'Maximum CPU time',
  HEAP_SIZE: 'Maximum heap size',
  CALLOUTS: 'Number of callouts',
  EMAIL_INVOCATIONS: 'Number of Email Invocations',
  FUTURE_CALLS: 'Number of future calls',
  QUEUEABLE_JOBS: 'Number of queueable jobs added to the queue',
  MOBILE_APEX_PUSH_CALLS: 'Number of Mobile Apex push calls',
  FIELDS_DESCRIBES: 'Number of field describes',
  FIELDSETS_DESCRIBES: 'Number of field set describes',
  RECORD_TYPES_DESCRIBES: 'Number of record type describes',
  CHILD_RELATIONSHIPS_DESCRIBES: 'Number of child relationship describes',
  PICKLIST_DESCRIBES: 'Number of picklist describes',
};

/** `FIELDSETS_DESCRIBES` → `Fieldsets Describes` for codes without a known label. */
function humanizeLimitType(code: string): string {
  return (
    LIMIT_TYPE_LABELS[code] ??
    code
      .toLowerCase()
      .split('_')
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
      .join(' ')
  );
}

function toPercent(used: number, max: number): number | null {
  if (!max) return null;
  return Math.round((used / max) * 1000) / 10;
}

/**
 * Counts Salesforce's own event stream already proves, keyed by the same
 * label `LIMIT_TYPE_LABELS`/the FOR_NS block use for that limit. `LIMIT_USAGE`
 * is an occasional checkpoint, not a running total — Salesforce logs it at a
 * handful of points, not on every increment — so for limits with a 1:1 event
 * in the log, the literal count is strictly more reliable than trusting
 * whichever snapshot happened to be captured.
 */
function directLimitCounts(events: LogEvent[]): Partial<Record<string, number>> {
  const count = (name: string) => events.filter((e) => e.event === name).length;
  let soqlRows = 0;
  for (const event of events) {
    if (event.event !== 'SOQL_EXECUTE_END') continue;
    const rowsField = event.fields.find((f) => ROWS_RE.test(f));
    if (rowsField) soqlRows += Number(ROWS_RE.exec(rowsField)?.[1] ?? 0);
  }
  return {
    'Number of SOQL queries': count('SOQL_EXECUTE_BEGIN'),
    'Number of SOSL queries': count('SOSL_EXECUTE_BEGIN'),
    'Number of DML statements': count('DML_BEGIN'),
    'Number of callouts': count('CALLOUT_REQUEST'),
    'Number of query rows': soqlRows,
  };
}

/**
 * Limit readings from two independent sources Salesforce may emit — the
 * end-of-transaction `LIMIT_USAGE_FOR_NS` block, and per-statement
 * `LIMIT_USAGE|[line]|TYPE|used|max` events logged as usage happens (governed
 * by a different level and not always paired with a FOR_NS block at all — a
 * log can carry only one of the two). Whichever reading for a given limit is
 * higher wins, so it doesn't matter which source or order they arrive in.
 * Limits with a reliable direct event count (`directLimitCounts`) are then
 * raised to that count if it's higher still — this is what actually happened,
 * not a possibly-stale snapshot.
 */
export function extractLimits(events: LogEvent[]): LimitUsage[] {
  const byName = new Map<string, LimitUsage>();
  const record = (name: string, used: number, max: number) => {
    const existing = byName.get(name);
    // Keep the highest reading seen — that is the transaction's peak.
    if (!existing || used >= existing.used) {
      byName.set(name, { name, used, max, percent: toPercent(used, max) });
    }
  };

  let inBlock = false;
  for (const event of events) {
    if (event.event === 'LIMIT_USAGE_FOR_NS') {
      inBlock = true;
      continue;
    }
    if (event.event === 'LIMIT_USAGE') {
      inBlock = false;
      const [, type, usedStr, maxStr] = event.fields;
      const used = Number(usedStr);
      const max = Number(maxStr);
      if (type && Number.isFinite(used) && Number.isFinite(max)) {
        record(humanizeLimitType(type), used, max);
      }
      continue;
    }
    if (event.event) {
      // Any other real event ends the continuation block.
      inBlock = false;
      continue;
    }
    if (!inBlock) continue;
    const match = LIMIT_RE.exec(event.raw);
    if (!match) continue;
    const [, name, usedStr, maxStr] = match;
    record(name, Number(usedStr), Number(maxStr));
  }

  for (const [name, directUsed] of Object.entries(directLimitCounts(events))) {
    const existing = byName.get(name);
    // Only raise a limit we already know the cap for — never fabricate one.
    if (existing && directUsed !== undefined && directUsed > existing.used) {
      byName.set(name, {
        ...existing,
        used: directUsed,
        percent: toPercent(directUsed, existing.max),
      });
    }
  }

  return [...byName.values()];
}

/** FATAL_ERROR / EXCEPTION_THROWN entries with the stack frames that follow them. */
export function extractExceptions(
  events: LogEvent[],
): { lineNo: number; message: string; stack: string[] }[] {
  const out: { lineNo: number; message: string; stack: string[] }[] = [];
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.event !== 'FATAL_ERROR' && event.event !== 'EXCEPTION_THROWN') continue;
    const message = event.fields.filter((f) => !/^\[\d+\]$/.test(f)).join(' | ');
    const stack: string[] = [];
    for (let j = i + 1; j < events.length && !events[j].event; j++) {
      const line = events[j].raw.trim();
      if (!line) break;
      stack.push(line);
      if (stack.length >= 25) break;
    }
    out.push({ lineNo: event.lineNo, message, stack });
  }
  return out;
}

function countRows(events: LogEvent[]): number {
  let rows = 0;
  for (const event of events) {
    if (event.event !== 'SOQL_EXECUTE_END' && event.event !== 'SOSL_EXECUTE_END') continue;
    for (const field of event.fields) {
      const match = ROWS_RE.exec(field);
      if (match) rows += Number(match[1]);
    }
  }
  return rows;
}

/** Wall-clock duration from the first to the last timestamped event. */
export function durationFromEvents(events: LogEvent[]): number | null {
  let first: number | null = null;
  let last: number | null = null;
  for (const event of events) {
    if (event.nanos === null) continue;
    if (first === null) first = event.nanos;
    last = event.nanos;
  }
  if (first === null || last === null) return null;
  return Math.round((last - first) / 1e6);
}

/** The slowest code units by self time — the "where did the time go" list. */
function slowestUnits(events: LogEvent[], limit = 15): CodeUnitTiming[] {
  const timings = flattenTimings(buildExecutionTree(events));
  return timings
    .filter((t) => t.selfMs !== null)
    .sort((a, b) => (b.selfMs ?? 0) - (a.selfMs ?? 0))
    .slice(0, limit)
    .map((t) => ({
      name: t.name,
      totalMs: t.totalMs ?? 0,
      selfMs: t.selfMs ?? 0,
      lineNo: t.lineNo,
    }));
}

export function buildSummary(events: LogEvent[], body: string): LogSummary {
  const count = (name: string) => events.filter((e) => e.event === name).length;
  return {
    durationMs: durationFromEvents(events),
    truncated: isTruncated(body),
    limits: extractLimits(events),
    counts: {
      soql: count('SOQL_EXECUTE_BEGIN'),
      sosl: count('SOSL_EXECUTE_BEGIN'),
      dml: count('DML_BEGIN'),
      callouts: count('CALLOUT_REQUEST'),
      userDebug: count('USER_DEBUG'),
      exceptions: count('FATAL_ERROR') + count('EXCEPTION_THROWN'),
      rows: countRows(events),
    },
    slowestUnits: slowestUnits(events),
    exceptions: extractExceptions(events),
  };
}

/** Source-line + statement text of every SOQL query, for the loop/N+1 rules. */
export function collectQueries(
  events: LogEvent[],
): { lineNo: number; sourceLine: number | null; text: string }[] {
  return events
    .filter((e) => e.event === 'SOQL_EXECUTE_BEGIN')
    .map((e) => ({
      lineNo: e.lineNo,
      sourceLine: sourceLineOf(e),
      // Last field is the query text; earlier ones are `[12]` and `Aggregations:0`.
      text: (e.fields[e.fields.length - 1] ?? '').trim(),
    }));
}

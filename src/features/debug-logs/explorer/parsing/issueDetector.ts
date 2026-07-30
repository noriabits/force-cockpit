// Heuristic rules that turn a parsed log into a ranked list of concrete
// problems. Deliberately conservative: every issue points at a line and quotes
// its evidence, so the user (and the model) can verify it against the log.
import type { LogEvent, LogIssue, LogSummary } from '../types';
import { sourceLineOf } from './logLine';
import { collectQueries } from './logSummary';

/** Repeats from one source line before we call it a loop. */
const LOOP_THRESHOLD = 5;
/** Repeats of the same query text before we call it an N+1. */
const REPEAT_QUERY_THRESHOLD = 10;
/** Rows from a single query before we call it non-selective. */
const WIDE_QUERY_ROWS = 10_000;

const SEVERITY_ORDER: Record<LogIssue['severity'], number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

/** Collapse literals so `WHERE Id = '001x'` and `WHERE Id = '001y'` count as one query. */
export function normalizeQuery(text: string): string {
  return text
    .replace(/'[^']*'/g, "'?'")
    .replace(/\b\d+\b/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function truncate(text: string, max = 160): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function countBy<T>(items: T[], key: (item: T) => string | null): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    if (k === null) continue;
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}

function repeatedStatements(
  events: LogEvent[],
  eventName: string,
  rule: string,
  label: string,
  suggestion: string,
  signatureOf: (e: LogEvent) => string | null,
): LogIssue[] {
  const statements = events.filter((e) => e.event === eventName);
  // Group by source line when the `[42]` marker is present. Managed/external
  // code logs `[EXTERNAL]` instead — fall back to the statement signature there
  // so the loop is still caught rather than silently dropped.
  const byOrigin = countBy(statements, (e) => {
    const line = sourceLineOf(e);
    if (line !== null) return `line:${line}`;
    const signature = signatureOf(e);
    return signature ? `text:${signature}` : null;
  });
  const issues: LogIssue[] = [];
  for (const [origin, group] of byOrigin) {
    if (group.length < LOOP_THRESHOLD) continue;
    // A shared helper (e.g. a generic dynamic-query executor) can land many
    // unrelated calls on one source line. Only count repeats of the *same*
    // statement as a loop — not every call that merely shares a line.
    const bySignature = countBy(group, (e) => signatureOf(e) ?? origin);
    for (const sameStatement of bySignature.values()) {
      if (sameStatement.length < LOOP_THRESHOLD) continue;
      const where = origin.startsWith('line:')
        ? `Source line ${origin.slice(5)}`
        : 'The same statement';
      issues.push({
        rule,
        severity: sameStatement.length >= LOOP_THRESHOLD * 4 ? 'critical' : 'warning',
        title: `${label} executed ${sameStatement.length}× from the same line`,
        detail:
          `${where} ran ${sameStatement.length} times in this transaction, which is the ` +
          `signature of a ${label.toLowerCase()} inside a loop.`,
        lineNo: sameStatement[0].lineNo,
        evidence: sameStatement.slice(0, 3).map((e) => truncate(e.raw)),
        suggestion,
      });
    }
  }
  return issues;
}

function repeatedQueries(events: LogEvent[]): LogIssue[] {
  const queries = collectQueries(events);
  const byText = countBy(queries, (q) => (q.text ? normalizeQuery(q.text) : null));
  const issues: LogIssue[] = [];
  for (const [, group] of byText) {
    if (group.length < REPEAT_QUERY_THRESHOLD) continue;
    // Already covered by the loop rule when they all come from one line.
    const lines = new Set(group.map((q) => q.sourceLine));
    if (lines.size === 1) continue;
    issues.push({
      rule: 'n-plus-one',
      severity: 'warning',
      title: `The same query ran ${group.length}× with different values`,
      detail:
        'A query repeated with only its filter values changing is the classic N+1 pattern: ' +
        'one query per record instead of one query for all of them.',
      lineNo: group[0].lineNo,
      evidence: [truncate(group[0].text)],
      suggestion:
        'Collect the ids first and run a single query with `WHERE Id IN :ids`, then index the ' +
        'result in a Map for lookup.',
    });
  }
  return issues;
}

function limitPressure(summary: LogSummary): LogIssue[] {
  const issues: LogIssue[] = [];
  for (const limit of summary.limits) {
    if (limit.percent === null || limit.percent < 80) continue;
    issues.push({
      rule: 'governor-limit',
      severity: limit.percent >= 100 ? 'critical' : 'warning',
      title: `${limit.name} at ${limit.percent}% of the limit`,
      detail: `${limit.used} out of ${limit.max} consumed in this transaction.`,
      lineNo: null,
      evidence: [`${limit.name}: ${limit.used} out of ${limit.max}`],
      suggestion:
        limit.percent >= 100
          ? 'This limit was exhausted — the transaction cannot grow any further without failing.'
          : 'Headroom is thin; a slightly larger data volume will hit the limit.',
    });
  }
  return issues;
}

function exceptions(summary: LogSummary): LogIssue[] {
  return summary.exceptions.map((ex) => ({
    rule: 'exception',
    severity: 'critical' as const,
    title: truncate(ex.message, 120) || 'Unhandled exception',
    detail: 'The transaction threw an exception.',
    lineNo: ex.lineNo,
    evidence: ex.stack.slice(0, 5),
    suggestion:
      'Follow the first stack frame to the class and line that threw, and check the state it ' +
      'assumed (null references, empty query results, missing custom settings).',
  }));
}

function triggerNameOf(e: LogEvent): string | null {
  const ref = e.fields.find((f) => f.includes('__sfdc_trigger/'));
  return ref ? ref.split('__sfdc_trigger/')[1] : null;
}

function recursiveTriggers(events: LogEvent[]): LogIssue[] {
  // Before/After halves of a single DML, or several separate top-level DML
  // statements against the same object, both make a trigger "run" more than
  // once in a transaction — that's normal. Genuine recursion is a trigger
  // invocation starting while an earlier invocation of the *same* trigger
  // hasn't finished yet (it re-entered itself via its own DML), so track
  // nesting depth per trigger name rather than counting raw start events.
  const depth = new Map<string, number>();
  const runsByTrigger = new Map<string, LogEvent[]>();
  const reentrant = new Set<string>();
  for (const e of events) {
    if (e.event === 'CODE_UNIT_STARTED') {
      const name = triggerNameOf(e);
      if (!name) continue;
      const current = depth.get(name) ?? 0;
      if (current > 0) reentrant.add(name);
      depth.set(name, current + 1);
      const runs = runsByTrigger.get(name);
      if (runs) runs.push(e);
      else runsByTrigger.set(name, [e]);
    } else if (e.event === 'CODE_UNIT_FINISHED') {
      const name = triggerNameOf(e);
      if (!name) continue;
      const current = depth.get(name) ?? 0;
      if (current > 0) depth.set(name, current - 1);
    }
  }
  const issues: LogIssue[] = [];
  for (const [name, runs] of runsByTrigger) {
    if (!reentrant.has(name)) continue;
    issues.push({
      rule: 'recursive-trigger',
      severity: runs.length > 3 ? 'warning' : 'info',
      title: `Trigger ${name} re-entered itself (${runs.length} runs in one transaction)`,
      detail:
        'A later run of this trigger started before an earlier run on the same object finished — ' +
        'the signature of the trigger re-triggering itself through its own DML, not just separate ' +
        'updates later in the transaction.',
      lineNo: runs[0].lineNo,
      evidence: runs.slice(0, 3).map((e) => truncate(e.raw)),
      suggestion: 'Add a static recursion guard, or move the re-entrant update out of the trigger.',
    });
  }
  return issues;
}

function wideQueries(events: LogEvent[]): LogIssue[] {
  const issues: LogIssue[] = [];
  for (const event of events) {
    if (event.event !== 'SOQL_EXECUTE_END') continue;
    const rowsField = event.fields.find((f) => /^Rows:\d+$/.test(f));
    if (!rowsField) continue;
    const rows = Number(rowsField.slice(5));
    if (rows < WIDE_QUERY_ROWS) continue;
    issues.push({
      rule: 'wide-query',
      severity: 'warning',
      title: `A single query returned ${rows.toLocaleString()} rows`,
      detail: 'Large result sets burn heap and query-row limits and are often non-selective.',
      lineNo: event.lineNo,
      evidence: [truncate(event.raw)],
      suggestion:
        'Add a selective, indexed filter, reduce the fields selected, or process the records in ' +
        'batches instead of loading them all at once.',
    });
  }
  return issues;
}

function truncatedLog(summary: LogSummary): LogIssue[] {
  if (!summary.truncated) return [];
  return [
    {
      rule: 'truncated-log',
      severity: 'warning',
      title: 'The log was truncated',
      detail:
        'Salesforce cut this log at the 20 MB budget, so the end of the transaction is missing ' +
        'and any analysis of it is incomplete.',
      lineNo: null,
      evidence: [],
      suggestion:
        'Re-run with a narrower debug level (the "USER_DEBUG only" or a focused preset), or ' +
        'keep the user flag quiet and add a class trace on the suspect class.',
    },
  ];
}

/** All rules, ranked most severe first. */
export function detectIssues(events: LogEvent[], summary: LogSummary): LogIssue[] {
  const issues = [
    ...exceptions(summary),
    ...limitPressure(summary),
    ...repeatedStatements(
      events,
      'SOQL_EXECUTE_BEGIN',
      'soql-in-loop',
      'SOQL query',
      'Move the query out of the loop: query once before the loop and index the results in a Map.',
      (e) => {
        const text = e.fields[e.fields.length - 1];
        return text ? normalizeQuery(text) : null;
      },
    ),
    ...repeatedStatements(
      events,
      'DML_BEGIN',
      'dml-in-loop',
      'DML statement',
      'Collect the records in a list inside the loop and perform a single DML after it.',
      (e) => {
        const op = e.fields.find((f) => f.startsWith('Op:'));
        const type = e.fields.find((f) => f.startsWith('Type:'));
        return op && type ? `${op}|${type}` : null;
      },
    ),
    ...repeatedQueries(events),
    ...wideQueries(events),
    ...recursiveTriggers(events),
    ...truncatedLog(summary),
  ];
  return issues.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

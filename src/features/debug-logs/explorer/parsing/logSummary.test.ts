import { describe, expect, it } from 'vitest';
import { parseLog } from './logLine';
import {
  buildSummary,
  collectQueries,
  durationFromEvents,
  extractExceptions,
  extractLimits,
} from './logSummary';
import { FATAL_LOG, SOQL_LOOP_LOG, SUCCESS_LOG, TRUNCATED_LOG } from './__fixtures__/logs';

describe('extractLimits', () => {
  it('reads the LIMIT_USAGE_FOR_NS block into usage percentages', () => {
    const { events } = parseLog(SUCCESS_LOG);
    const limits = extractLimits(events);
    const soql = limits.find((l) => l.name === 'Number of SOQL queries');
    expect(soql).toEqual({ name: 'Number of SOQL queries', used: 1, max: 100, percent: 1 });
    const cpu = limits.find((l) => l.name === 'Maximum CPU time');
    expect(cpu?.percent).toBe(2);
  });

  it('reads a limit line carrying the "CLOSE TO LIMIT" marker Salesforce appends near threshold', () => {
    // Regression: LIMIT_RE used to anchor on end-of-line right after the max,
    // so this trailing marker — which only appears on the lines this feature
    // exists to flag — made the line fail to match at all.
    const log = [
      '65.0 APEX_CODE,DEBUG',
      '09:00:00.1 (1)|LIMIT_USAGE_FOR_NS|(default)|',
      '  Maximum CPU time: 8003 out of 10000 ******* CLOSE TO LIMIT',
      '09:00:00.1 (2)|EXECUTION_FINISHED',
    ].join('\n');
    const limits = extractLimits(parseLog(log).events);
    const cpu = limits.find((l) => l.name === 'Maximum CPU time');
    expect(cpu).toEqual({ name: 'Maximum CPU time', used: 8003, max: 10000, percent: 80 });
  });

  it('reads per-statement LIMIT_USAGE events, not just the LIMIT_USAGE_FOR_NS block', () => {
    // Regression: a log can carry only LIMIT_USAGE lines (governed by a
    // different level than the FOR_NS summary block) and extractLimits used
    // to ignore that event type entirely — no bars, no governor-limit issue,
    // no matter how close to a limit the transaction actually was.
    const log = [
      '65.0 APEX_CODE,DEBUG',
      '10:55:12.0 (1)|LIMIT_USAGE|[291]|FIELDSETS_DESCRIBES|1|100',
      '10:55:12.0 (2)|LIMIT_USAGE|[35]|SOQL|1|100',
      '10:55:12.0 (3)|LIMIT_USAGE|[35]|SOQL_ROWS|2|50000',
      '10:55:12.0 (4)|LIMIT_USAGE|[35]|SOQL_ROWS|35|50000',
    ].join('\n');
    const limits = extractLimits(parseLog(log).events);
    expect(limits).toContainEqual({
      name: 'Number of SOQL queries',
      used: 1,
      max: 100,
      percent: 1,
    });
    // Peak reading wins across repeated LIMIT_USAGE lines for the same type.
    expect(limits).toContainEqual({
      name: 'Number of query rows',
      used: 35,
      max: 50000,
      percent: 0.1,
    });
    // FIELDSETS_DESCRIBES has an explicit label rather than the raw code.
    expect(limits).toContainEqual({
      name: 'Number of field set describes',
      used: 1,
      max: 100,
      percent: 1,
    });
  });

  it('falls back to a humanized name for a code with no known label', () => {
    const log = [
      '65.0 APEX_CODE,DEBUG',
      '09:00:00.1 (1)|LIMIT_USAGE|[1]|NAMESPACES_REAL|1|10',
    ].join('\n');
    const limits = extractLimits(parseLog(log).events);
    expect(limits).toContainEqual({ name: 'Namespaces Real', used: 1, max: 10, percent: 10 });
  });

  it('merges LIMIT_USAGE and LIMIT_USAGE_FOR_NS readings for the same limit, keeping the peak', () => {
    const log = [
      '65.0 APEX_CODE,DEBUG',
      '09:00:00.1 (1)|LIMIT_USAGE|[10]|SOQL|1|100',
      '09:00:00.1 (2)|LIMIT_USAGE_FOR_NS|(default)|',
      '  Number of SOQL queries: 4 out of 100',
      '09:00:00.1 (3)|EXECUTION_FINISHED',
    ].join('\n');
    const limits = extractLimits(parseLog(log).events);
    const soql = limits.find((l) => l.name === 'Number of SOQL queries');
    expect(soql?.used).toBe(4);
  });

  it('raises SOQL query/row counts to the real event count when LIMIT_USAGE only caught an early snapshot', () => {
    // Regression: Salesforce logs LIMIT_USAGE as an occasional checkpoint, not
    // on every query — a log with 3 real SOQL statements can carry just one
    // LIMIT_USAGE|SOQL|1|100 line from right after the first. Trusting that
    // snapshot alone showed "1 of 100" next to a summary chip correctly
    // reading 3 SOQL queries.
    const log = [
      '65.0 APEX_CODE,DEBUG',
      '09:00:00.1 (1)|SOQL_EXECUTE_BEGIN|[1]|Aggregations:0|SELECT Id FROM Account',
      '09:00:00.1 (2)|SOQL_EXECUTE_END|[1]|Rows:5',
      '09:00:00.1 (3)|LIMIT_USAGE|[1]|SOQL|1|100',
      '09:00:00.1 (4)|SOQL_EXECUTE_BEGIN|[2]|Aggregations:0|SELECT Id FROM Contact',
      '09:00:00.1 (5)|SOQL_EXECUTE_END|[2]|Rows:7',
      '09:00:00.1 (6)|SOQL_EXECUTE_BEGIN|[3]|Aggregations:0|SELECT Id FROM Opportunity',
      '09:00:00.1 (7)|SOQL_EXECUTE_END|[3]|Rows:3',
    ].join('\n');
    const limits = extractLimits(parseLog(log).events);
    const soql = limits.find((l) => l.name === 'Number of SOQL queries');
    expect(soql).toEqual({ name: 'Number of SOQL queries', used: 3, max: 100, percent: 3 });
    // "Number of query rows" has no LIMIT_USAGE reading at all here, so there
    // is no known max to attach a count to — it simply isn't reported, same
    // as before this fix.
    expect(limits.find((l) => l.name === 'Number of query rows')).toBeUndefined();
  });

  it('does not raise a count above a genuinely higher LIMIT_USAGE/FOR_NS reading', () => {
    // The direct count is a floor, not an override — a limit whose usage
    // dropped after a savepoint rollback (or was captured after the events we
    // can see) should keep the higher, already-correct reading.
    const log = [
      '65.0 APEX_CODE,DEBUG',
      '09:00:00.1 (1)|SOQL_EXECUTE_BEGIN|[1]|Aggregations:0|SELECT Id FROM Account',
      '09:00:00.1 (2)|SOQL_EXECUTE_END|[1]|Rows:1',
      '09:00:00.1 (3)|LIMIT_USAGE_FOR_NS|(default)|',
      '  Number of SOQL queries: 9 out of 100',
    ].join('\n');
    const limits = extractLimits(parseLog(log).events);
    expect(limits.find((l) => l.name === 'Number of SOQL queries')?.used).toBe(9);
  });

  it('keeps the peak reading when a limit appears more than once', () => {
    const log = [
      '65.0 APEX_CODE,DEBUG',
      '09:00:00.1 (1)|LIMIT_USAGE_FOR_NS|(default)|',
      '  Number of SOQL queries: 2 out of 100',
      '09:00:00.1 (2)|EXECUTION_FINISHED',
      '09:00:00.1 (3)|LIMIT_USAGE_FOR_NS|(default)|',
      '  Number of SOQL queries: 7 out of 100',
    ].join('\n');
    const limits = extractLimits(parseLog(log).events);
    expect(limits[0].used).toBe(7);
  });
});

describe('extractExceptions', () => {
  it('captures the message and the stack frames that follow it', () => {
    const { events } = parseLog(FATAL_LOG);
    const exceptions = extractExceptions(events);
    expect(exceptions).toHaveLength(2); // EXCEPTION_THROWN + FATAL_ERROR
    const fatal = exceptions[1];
    expect(fatal.message).toContain('NullPointerException');
    expect(fatal.stack[0]).toContain('OrderService.calculate: line 42');
  });
});

describe('durationFromEvents', () => {
  it('measures first to last timestamped event in milliseconds', () => {
    const { events } = parseLog(SUCCESS_LOG);
    expect(durationFromEvents(events)).toBe(22);
  });

  it('returns null when nothing is timestamped', () => {
    expect(durationFromEvents(parseLog('just text\nmore text').events)).toBeNull();
  });
});

describe('buildSummary', () => {
  it('counts statements, rows and exceptions', () => {
    const { events } = parseLog(SUCCESS_LOG);
    const summary = buildSummary(events, SUCCESS_LOG);
    expect(summary.counts.soql).toBe(1);
    expect(summary.counts.rows).toBe(10);
    expect(summary.counts.userDebug).toBe(1);
    expect(summary.counts.exceptions).toBe(0);
    expect(summary.truncated).toBe(false);
  });

  it('flags a truncated log', () => {
    const { events } = parseLog(TRUNCATED_LOG);
    expect(buildSummary(events, TRUNCATED_LOG).truncated).toBe(true);
  });

  it('ranks the slowest code units by self time', () => {
    const { events } = parseLog(SUCCESS_LOG);
    const summary = buildSummary(events, SUCCESS_LOG);
    expect(summary.slowestUnits[0].name).toBe('AccountService.run');
    expect(summary.slowestUnits[0].totalMs).toBe(20);
  });
});

describe('collectQueries', () => {
  it('returns the source line and query text of every SOQL statement', () => {
    const { events } = parseLog(SOQL_LOOP_LOG);
    const queries = collectQueries(events);
    expect(queries).toHaveLength(8);
    expect(queries[0].sourceLine).toBe(42);
    expect(queries[0].text).toContain('SELECT Id FROM Contact');
  });
});

import { describe, expect, it } from 'vitest';
import { detectIssues, normalizeQuery } from './issueDetector';
import { parseLog } from './logLine';
import { buildSummary } from './logSummary';
import { FATAL_LOG, SOQL_LOOP_LOG, SUCCESS_LOG, TRUNCATED_LOG } from './__fixtures__/logs';

function issuesFor(log: string) {
  const { events } = parseLog(log);
  return detectIssues(events, buildSummary(events, log));
}

describe('normalizeQuery', () => {
  it('collapses literals so the same query with different values matches', () => {
    expect(normalizeQuery("SELECT Id FROM Contact WHERE AccountId = '001a'")).toBe(
      normalizeQuery("SELECT Id FROM Contact WHERE AccountId = '001b'"),
    );
  });
});

describe('detectIssues', () => {
  it('finds nothing worth reporting in a healthy log', () => {
    expect(issuesFor(SUCCESS_LOG)).toEqual([]);
  });

  it('reports the exception first for a failed transaction', () => {
    const issues = issuesFor(FATAL_LOG);
    expect(issues[0].rule).toBe('exception');
    expect(issues[0].severity).toBe('critical');
    expect(issues[0].title).toContain('NullPointerException');
    expect(issues[0].lineNo).not.toBeNull();
  });

  it('detects SOQL issued repeatedly from one source line', () => {
    const issues = issuesFor(SOQL_LOOP_LOG);
    const loop = issues.find((i) => i.rule === 'soql-in-loop');
    expect(loop?.title).toContain('8×');
    expect(loop?.evidence.length).toBeGreaterThan(0);
    expect(loop?.suggestion).toContain('out of the loop');
  });

  it('detects the loop in a CRLF log body too', () => {
    // Regression: a trailing \r used to make every line parse as a
    // continuation, so no rule ever fired.
    const issues = issuesFor(SOQL_LOOP_LOG.split('\n').join('\r\n'));
    expect(issues.some((i) => i.rule === 'soql-in-loop')).toBe(true);
  });

  it('falls back to the statement text when the source-line marker is [EXTERNAL]', () => {
    const log = [
      '65.0 APEX_CODE,FINE;DB,FINEST',
      ...Array.from(
        { length: 6 },
        (_, i) =>
          `11:00:00.1 (${i * 1000})|SOQL_EXECUTE_BEGIN|[EXTERNAL]|Aggregations:0|SELECT Id FROM Contact WHERE AccountId = '001${i}'`,
      ),
    ].join('\n');
    const loop = issuesFor(log).find((i) => i.rule === 'soql-in-loop');
    expect(loop?.title).toContain('6×');
    expect(loop?.detail).toContain('The same statement');
  });

  it('flags governor-limit pressure above 80%', () => {
    const issues = issuesFor(SOQL_LOOP_LOG);
    const cpu = issues.find((i) => i.rule === 'governor-limit');
    expect(cpu?.title).toContain('Maximum CPU time');
    expect(cpu?.severity).toBe('warning');
  });

  it('recommends a narrower level when the log was truncated', () => {
    const issues = issuesFor(TRUNCATED_LOG);
    const truncated = issues.find((i) => i.rule === 'truncated-log');
    expect(truncated).toBeDefined();
    expect(truncated?.suggestion).toContain('class trace');
  });

  it('reports a recursive trigger', () => {
    const log = [
      '65.0 APEX_CODE,DEBUG',
      '09:00:00.1 (1)|CODE_UNIT_STARTED|[EXTERNAL]|01q000|OrderTrigger on Order trigger event BeforeUpdate|__sfdc_trigger/OrderTrigger',
      '09:00:00.1 (2)|CODE_UNIT_FINISHED|OrderTrigger',
      '09:00:00.1 (3)|CODE_UNIT_STARTED|[EXTERNAL]|01q000|OrderTrigger on Order trigger event BeforeUpdate|__sfdc_trigger/OrderTrigger',
      '09:00:00.1 (4)|CODE_UNIT_FINISHED|OrderTrigger',
    ].join('\n');
    const recursive = issuesFor(log).find((i) => i.rule === 'recursive-trigger');
    expect(recursive?.title).toContain('OrderTrigger ran 2×');
  });

  it('ranks critical issues above warnings', () => {
    const log = FATAL_LOG + '\n' + SOQL_LOOP_LOG.split('\n').slice(1).join('\n');
    const issues = issuesFor(log);
    const severities = issues.map((i) => i.severity);
    expect(severities.indexOf('critical')).toBeLessThan(severities.lastIndexOf('warning'));
  });
});

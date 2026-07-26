import { describe, expect, it } from 'vitest';
import { buildLogDigest } from './logDigest';
import { buildExecutionTree } from '../parsing/executionTree';
import { detectIssues } from '../parsing/issueDetector';
import { parseLog } from '../parsing/logLine';
import { buildSummary } from '../parsing/logSummary';
import { FATAL_LOG, SOQL_LOOP_LOG, SUCCESS_LOG } from '../parsing/__fixtures__/logs';
import type { ApexLogRow, ParsedLog } from '../types';

function parse(log: string): { parsed: ParsedLog; totalLines: number } {
  const { header, events } = parseLog(log);
  const summary = buildSummary(events, log);
  return {
    parsed: {
      header,
      events,
      summary,
      issues: detectIssues(events, summary),
      tree: buildExecutionTree(events),
    },
    totalLines: events.length,
  };
}

const row: ApexLogRow = {
  id: '07L1',
  logUserId: '005x',
  logUserName: 'Automated Process',
  operation: 'OrderTrigger',
  application: 'Unknown',
  status: 'System.NullPointerException',
  request: 'Api',
  durationMilliseconds: 812,
  logLength: 40_000,
  startTime: '2026-07-26T09:00:00.000+0000',
};

describe('buildLogDigest', () => {
  it('leads with the metadata and the captured log levels', () => {
    const { parsed, totalLines } = parse(SUCCESS_LOG);
    const digest = buildLogDigest({ row, parsed, totalLines });
    expect(digest).toContain('## Log metadata');
    expect(digest).toContain('Automated Process');
    expect(digest).toContain('## Captured log levels');
    expect(digest).toContain('APEX_CODE=DEBUG');
    // The model must know what was NOT captured before drawing conclusions.
    expect(digest).toContain('absent from this log');
  });

  it('includes limits, counts and the debug output', () => {
    const { parsed, totalLines } = parse(SUCCESS_LOG);
    const digest = buildLogDigest({ row, parsed, totalLines });
    expect(digest).toContain('Number of SOQL queries: 1 / 100');
    expect(digest).toContain('SOQL 1');
    expect(digest).toContain('loaded 10 accounts');
  });

  it('quotes each exception with surrounding context lines', () => {
    const { parsed, totalLines } = parse(FATAL_LOG);
    const digest = buildLogDigest({ row, parsed, totalLines });
    expect(digest).toContain('NullPointerException');
    expect(digest).toMatch(/L\d+ .*FATAL_ERROR/);
    expect(digest).toContain('OrderService.calculate');
  });

  it('lists the heuristic issues so the model starts from evidence', () => {
    const { parsed, totalLines } = parse(SOQL_LOOP_LOG);
    const digest = buildLogDigest({ row, parsed, totalLines });
    expect(digest).toContain('soql-in-loop');
    expect(digest).toContain('[warning]');
  });

  it('middle-truncates huge debug output to respect the budget', () => {
    const noisy = [
      '65.0 APEX_CODE,DEBUG',
      ...Array.from(
        { length: 4000 },
        (_, i) => `09:00:00.1 (${i})|USER_DEBUG|[1]|DEBUG|line ${i} ${'x'.repeat(60)}`,
      ),
    ].join('\n');
    const { parsed, totalLines } = parse(noisy);
    const digest = buildLogDigest({ row, parsed, totalLines, budget: 4000 });
    expect(digest).toContain('middle omitted');
    expect(digest.length).toBeLessThan(12_000);
  });

  it('says so plainly when a section has no data', () => {
    const { parsed, totalLines } = parse('65.0 APEX_CODE,NONE\n09:00:00.1 (1)|EXECUTION_STARTED');
    const digest = buildLogDigest({ row: null, parsed, totalLines });
    expect(digest).toContain('_No limit data captured');
    expect(digest).toContain('_No exceptions in the log._');
    expect(digest).toContain('_No System.debug output captured._');
    expect(digest).toContain('_Log metadata unavailable._');
  });
});

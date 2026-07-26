import { describe, expect, it } from 'vitest';
import { parseLog } from './logLine';
import { extractQueryPlans } from './queryPlan';

const HEADER = '67.0 APEX_CODE,FINEST;APEX_PROFILING,FINEST;DB,FINEST';

describe('extractQueryPlans', () => {
  it('pairs a TableScan explain with its query and row count, rated critical', () => {
    const log = [
      HEADER,
      '10:55:12.1 (1)|SOQL_EXECUTE_BEGIN|[891]|Aggregations:0|SELECT Id, DeveloperName FROM RecordType WHERE IsActive = TRUE',
      '10:55:12.1 (2)|SOQL_EXECUTE_EXPLAIN|[891]|TableScan on RecordType : [], cardinality: 0, sobjectCardinality: 10, relativeCost 0.667',
      '10:55:12.1 (3)|SOQL_EXECUTE_END|[891]|Rows:95',
    ].join('\n');
    const [plan] = extractQueryPlans(parseLog(log).events);
    expect(plan).toEqual({
      lineNo: 2,
      sourceLine: 891,
      text: 'SELECT Id, DeveloperName FROM RecordType WHERE IsActive = TRUE',
      rows: 95,
      operation: 'TableScan',
      object: 'RecordType',
      fieldsUsed: [],
      cardinality: 0,
      sobjectCardinality: 10,
      relativeCost: 0.667,
      rating: 'critical',
    });
  });

  it('rates an indexed, selective query as good', () => {
    const log = [
      HEADER,
      '10:55:12.1 (1)|SOQL_EXECUTE_BEGIN|[2508]|Aggregations:0|SELECT Id FROM QuoteLineItem WHERE QuoteId = :CartId',
      '10:55:12.1 (2)|SOQL_EXECUTE_EXPLAIN|[2508]|Index on QuoteLineItem : [QuoteId], cardinality: 1, sobjectCardinality: 786, relativeCost 0.004',
      '10:55:12.1 (3)|SOQL_EXECUTE_END|[2508]|Rows:2',
    ].join('\n');
    const [plan] = extractQueryPlans(parseLog(log).events);
    expect(plan.operation).toBe('Index');
    expect(plan.fieldsUsed).toEqual(['QuoteId']);
    expect(plan.rating).toBe('good');
  });

  it('rates a non-TableScan plan with relativeCost >= 1 as warning', () => {
    const log = [
      HEADER,
      '10:55:12.1 (1)|SOQL_EXECUTE_BEGIN|[1]|Aggregations:0|SELECT Id FROM Account',
      '10:55:12.1 (2)|SOQL_EXECUTE_EXPLAIN|[1]|Other on Account : [], cardinality: 500, sobjectCardinality: 500, relativeCost 1.2',
      '10:55:12.1 (3)|SOQL_EXECUTE_END|[1]|Rows:500',
    ].join('\n');
    const [plan] = extractQueryPlans(parseLog(log).events);
    expect(plan.operation).toBe('Other');
    expect(plan.rating).toBe('warning');
  });

  it('leaves a query with no explain plan as unknown, still capturing its row count', () => {
    const log = [
      HEADER,
      '10:55:12.1 (1)|SOQL_EXECUTE_BEGIN|[35]|Aggregations:0|SELECT Id FROM VlocityHook__mdt',
      '10:55:12.1 (2)|SOQL_EXECUTE_EXPLAIN|[35]|No explain plan is available',
      '10:55:12.1 (3)|SOQL_EXECUTE_END|[35]|Rows:33',
    ].join('\n');
    const [plan] = extractQueryPlans(parseLog(log).events);
    expect(plan.operation).toBe('Unknown');
    expect(plan.relativeCost).toBeNull();
    expect(plan.rows).toBe(33);
    expect(plan.rating).toBe('unknown');
  });

  it('is unknown when there is no SOQL_EXECUTE_EXPLAIN event at all', () => {
    const log = [
      HEADER,
      '10:55:12.1 (1)|SOQL_EXECUTE_BEGIN|[1]|Aggregations:0|SELECT Id FROM Account',
      '10:55:12.1 (2)|SOQL_EXECUTE_END|[1]|Rows:1',
    ].join('\n');
    const [plan] = extractQueryPlans(parseLog(log).events);
    expect(plan.operation).toBe('Unknown');
    expect(plan.rating).toBe('unknown');
  });

  it('parses every query independently across a whole transaction (the reported log)', () => {
    const log = [
      HEADER,
      '10:55:12.1 (1)|SOQL_EXECUTE_BEGIN|[891]|Aggregations:0|SELECT Id, DeveloperName, SobjectType FROM RecordType WHERE IsActive = TRUE AND NamespacePrefix = :NS',
      '10:55:12.1 (2)|SOQL_EXECUTE_EXPLAIN|[891]|TableScan on RecordType : [], cardinality: 0, sobjectCardinality: 10, relativeCost 0.667',
      '10:55:12.1 (3)|SOQL_EXECUTE_END|[891]|Rows:95',
      '10:55:12.1 (4)|SOQL_EXECUTE_BEGIN|[2508]|Aggregations:0|SELECT Id, Product2Id FROM QuoteLineItem WHERE QuoteId = :CartId',
      '10:55:12.1 (5)|SOQL_EXECUTE_EXPLAIN|[2508]|Index on QuoteLineItem : [QuoteId], cardinality: 1, sobjectCardinality: 786, relativeCost 0.004',
      '10:55:12.1 (6)|SOQL_EXECUTE_END|[2508]|Rows:2',
      '10:55:12.1 (7)|SOQL_EXECUTE_BEGIN|[35]|Aggregations:0|SELECT Id,DeveloperName FROM VlocityHook__mdt',
      '10:55:12.1 (8)|SOQL_EXECUTE_EXPLAIN|[35]|No explain plan is available',
      '10:55:12.1 (9)|SOQL_EXECUTE_END|[35]|Rows:33',
    ].join('\n');
    const plans = extractQueryPlans(parseLog(log).events);
    expect(plans).toHaveLength(3);
    expect(plans.map((p) => p.rating)).toEqual(['critical', 'good', 'unknown']);
  });

  it('still emits a query left open by a truncated log, with a null row count', () => {
    const log = [
      HEADER,
      '10:55:12.1 (1)|SOQL_EXECUTE_BEGIN|[1]|Aggregations:0|SELECT Id FROM Account',
      '10:55:12.1 (2)|SOQL_EXECUTE_EXPLAIN|[1]|Index on Account : [Id], cardinality: 1, sobjectCardinality: 100, relativeCost 0.01',
      '*********** MAXIMUM DEBUG LOG SIZE REACHED ***********',
    ].join('\n');
    const plans = extractQueryPlans(parseLog(log).events);
    expect(plans).toHaveLength(1);
    expect(plans[0].rows).toBeNull();
    expect(plans[0].rating).toBe('good');
  });
});

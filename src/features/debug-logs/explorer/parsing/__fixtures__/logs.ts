// Realistic (trimmed) debug logs used by the parsing tests.

export const HEADER =
  '65.0 APEX_CODE,DEBUG;APEX_PROFILING,INFO;CALLOUT,INFO;DB,INFO;SYSTEM,DEBUG;VALIDATION,INFO;VISUALFORCE,INFO;WORKFLOW,INFO';

/** A healthy transaction: one code unit, one query, some debug output. */
export const SUCCESS_LOG = [
  HEADER,
  '09:00:00.1 (1000000)|EXECUTION_STARTED',
  '09:00:00.1 (2000000)|CODE_UNIT_STARTED|[EXTERNAL]|01p0000000AAA|AccountService.run',
  '09:00:00.1 (3000000)|METHOD_ENTRY|[12]|01p0000000AAA|AccountService.loadAccounts()',
  '09:00:00.1 (4000000)|SOQL_EXECUTE_BEGIN|[13]|Aggregations:0|SELECT Id FROM Account LIMIT 10',
  '09:00:00.1 (6000000)|SOQL_EXECUTE_END|[13]|Rows:10',
  '09:00:00.1 (7000000)|USER_DEBUG|[14]|DEBUG|loaded 10 accounts',
  '09:00:00.1 (8000000)|METHOD_EXIT|[12]|AccountService.loadAccounts()',
  '09:00:00.2 (20000000)|CUMULATIVE_LIMIT_USAGE',
  '09:00:00.2 (20000000)|LIMIT_USAGE_FOR_NS|(default)|',
  '  Number of SOQL queries: 1 out of 100',
  '  Number of query rows: 10 out of 50000',
  '  Maximum CPU time: 200 out of 10000',
  '09:00:00.2 (20000000)|CUMULATIVE_LIMIT_USAGE_END',
  '09:00:00.2 (22000000)|CODE_UNIT_FINISHED|AccountService.run',
  '09:00:00.2 (23000000)|EXECUTION_FINISHED',
].join('\n');

/** An unhandled exception with a stack trace. */
export const FATAL_LOG = [
  HEADER,
  '10:00:00.1 (1000000)|EXECUTION_STARTED',
  '10:00:00.1 (2000000)|CODE_UNIT_STARTED|[EXTERNAL]|01p0000000BBB|OrderTrigger',
  '10:00:00.1 (3000000)|USER_DEBUG|[3]|DEBUG|about to explode',
  '10:00:00.1 (4000000)|EXCEPTION_THROWN|[7]|System.NullPointerException: Attempt to de-reference a null object',
  '10:00:00.1 (5000000)|FATAL_ERROR|System.NullPointerException: Attempt to de-reference a null object',
  'Class.OrderService.calculate: line 42, column 1',
  'Trigger.OrderTrigger: line 7, column 1',
  '10:00:00.1 (6000000)|CODE_UNIT_FINISHED|OrderTrigger',
  '10:00:00.1 (7000000)|EXECUTION_FINISHED',
].join('\n');

/** The same query issued from one line inside a loop, plus CPU pressure. */
export const SOQL_LOOP_LOG = [
  HEADER,
  '11:00:00.1 (1000000)|EXECUTION_STARTED',
  ...Array.from({ length: 8 }, (_, i) =>
    [
      `11:00:00.1 (${(i + 2) * 1000000})|SOQL_EXECUTE_BEGIN|[42]|Aggregations:0|SELECT Id FROM Contact WHERE AccountId = '001${i}'`,
      `11:00:00.1 (${(i + 2) * 1000000 + 500000})|SOQL_EXECUTE_END|[42]|Rows:1`,
    ].join('\n'),
  ),
  '11:00:00.2 (20000000)|LIMIT_USAGE_FOR_NS|(default)|',
  '  Number of SOQL queries: 8 out of 100',
  '  Maximum CPU time: 9500 out of 10000',
  '11:00:00.2 (21000000)|EXECUTION_FINISHED',
].join('\n');

/** A log Salesforce cut short. */
export const TRUNCATED_LOG = [
  HEADER,
  '12:00:00.1 (1000000)|EXECUTION_STARTED',
  '12:00:00.1 (2000000)|USER_DEBUG|[1]|DEBUG|start',
  '*********** MAXIMUM DEBUG LOG SIZE REACHED ***********',
].join('\n');

/** A transaction that did nothing observable — the noise filter's target. */
export const EMPTY_LOG = [
  HEADER,
  '13:00:00.1 (1000000)|EXECUTION_STARTED',
  '13:00:00.1 (1100000)|HEAP_ALLOCATE|[EXTERNAL]|Bytes:3',
  '13:00:00.1 (1200000)|STATEMENT_EXECUTE|[1]',
  '13:00:00.1 (1300000)|EXECUTION_FINISHED',
].join('\n');

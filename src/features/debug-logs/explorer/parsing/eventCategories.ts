// Groups debug-log event identifiers into the categories the viewer filters by.
// One event belongs to exactly one group; unknown events fall into 'other' so
// nothing is ever silently dropped.
import type { LogEvent } from '../types';

export type EventGroup =
  | 'errors'
  | 'userDebug'
  | 'soql'
  | 'dml'
  | 'callouts'
  | 'limits'
  | 'codeUnits'
  | 'flow'
  | 'validation'
  | 'noise'
  | 'other';

/** Display order + labels for the filter chips. */
export const EVENT_GROUP_LABELS: { id: EventGroup; label: string }[] = [
  { id: 'errors', label: 'Errors' },
  { id: 'userDebug', label: 'USER_DEBUG' },
  { id: 'soql', label: 'SOQL / SOSL' },
  { id: 'dml', label: 'DML' },
  { id: 'callouts', label: 'Callouts' },
  { id: 'limits', label: 'Limits' },
  { id: 'codeUnits', label: 'Code units' },
  { id: 'flow', label: 'Flow / Workflow' },
  { id: 'validation', label: 'Validation' },
  { id: 'noise', label: 'Heap / variables' },
  { id: 'other', label: 'Other' },
];

const EXACT: Record<string, EventGroup> = {
  FATAL_ERROR: 'errors',
  EXCEPTION_THROWN: 'errors',
  USER_DEBUG: 'userDebug',
  SOQL_EXECUTE_BEGIN: 'soql',
  SOQL_EXECUTE_END: 'soql',
  SOQL_EXECUTE_EXPLAIN: 'soql',
  SOSL_EXECUTE_BEGIN: 'soql',
  SOSL_EXECUTE_END: 'soql',
  DML_BEGIN: 'dml',
  DML_END: 'dml',
  CALLOUT_REQUEST: 'callouts',
  CALLOUT_RESPONSE: 'callouts',
  LIMIT_USAGE: 'limits',
  LIMIT_USAGE_FOR_NS: 'limits',
  CUMULATIVE_LIMIT_USAGE: 'limits',
  CUMULATIVE_LIMIT_USAGE_END: 'limits',
  CUMULATIVE_PROFILING: 'limits',
  CUMULATIVE_PROFILING_BEGIN: 'limits',
  CUMULATIVE_PROFILING_END: 'limits',
  CODE_UNIT_STARTED: 'codeUnits',
  CODE_UNIT_FINISHED: 'codeUnits',
  METHOD_ENTRY: 'codeUnits',
  METHOD_EXIT: 'codeUnits',
  CONSTRUCTOR_ENTRY: 'codeUnits',
  CONSTRUCTOR_EXIT: 'codeUnits',
  EXECUTION_STARTED: 'codeUnits',
  EXECUTION_FINISHED: 'codeUnits',
  VALIDATION_RULE: 'validation',
  VALIDATION_FAIL: 'validation',
  VALIDATION_PASS: 'validation',
  VALIDATION_FORMULA: 'validation',
  HEAP_ALLOCATE: 'noise',
  HEAP_DEALLOCATE: 'noise',
  STATEMENT_EXECUTE: 'noise',
  VARIABLE_SCOPE_BEGIN: 'noise',
  VARIABLE_SCOPE_END: 'noise',
  VARIABLE_ASSIGNMENT: 'noise',
};

const PREFIX: { prefix: string; group: EventGroup }[] = [
  { prefix: 'FLOW_', group: 'flow' },
  { prefix: 'WF_', group: 'flow' },
  { prefix: 'PROCESS_', group: 'flow' },
  { prefix: 'BULK_', group: 'flow' },
  { prefix: 'SYSTEM_METHOD_', group: 'noise' },
  { prefix: 'SYSTEM_MODE_', group: 'noise' },
  { prefix: 'SYSTEM_CONSTRUCTOR_', group: 'noise' },
];

/** Events that always signal a failure, whatever their group. */
const ERROR_EVENTS = new Set(['FATAL_ERROR', 'EXCEPTION_THROWN', 'VALIDATION_FAIL']);

export function groupOf(event: string): EventGroup {
  if (!event) return 'other';
  const exact = EXACT[event];
  if (exact) return exact;
  for (const { prefix, group } of PREFIX) {
    if (event.startsWith(prefix)) return group;
  }
  if (event.endsWith('_ERROR')) return 'errors';
  return 'other';
}

/** True for the events that mark something going wrong. */
export function isErrorEvent(event: LogEvent): boolean {
  if (ERROR_EVENTS.has(event.event)) return true;
  if (event.event.endsWith('_ERROR')) return true;
  // A callout that came back with a non-2xx status.
  if (event.event === 'CALLOUT_RESPONSE') {
    return /\b(4\d{2}|5\d{2})\b/.test(event.fields.join('|'));
  }
  return false;
}

/** The groups hidden by the viewer's default-on "Hide noise" toggle. */
export const NOISE_GROUPS: EventGroup[] = ['noise'];

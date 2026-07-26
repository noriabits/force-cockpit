// Pairs every SOQL statement with its (optional) SOQL_EXECUTE_EXPLAIN query
// plan and its row count, then rates it so a poorly-performing query (a full
// table scan, or anything Salesforce itself estimates as non-selective) is
// obvious without reading the raw log line by line.
import type { LogEvent, QueryPlanEntry, QueryPlanOperation, QueryPlanRating } from '../types';
import { sourceLineOf } from './logLine';

/**
 * `TableScan on RecordType : [], cardinality: 0, sobjectCardinality: 10, relativeCost 0.667`
 * or `Index on QuoteLineItem : [QuoteId], cardinality: 1, sobjectCardinality: 786, relativeCost 0.004`.
 * "No explain plan is available" (custom metadata, some system objects) simply
 * doesn't match — that query is left with its 'Unknown' defaults.
 */
const EXPLAIN_RE =
  /^(TableScan|Index|Other)\s+on\s+(\S+)\s*:\s*\[([^\]]*)\]\s*,\s*cardinality:\s*(\d+)\s*,\s*sobjectCardinality:\s*(\d+)\s*,\s*relativeCost\s+([\d.]+)/;
/** `|SOQL_EXECUTE_END|[12]|Rows:20` */
const ROWS_RE = /^Rows:(\d+)$/;

/** Salesforce's own threshold: a plan with relativeCost >= 1 is non-selective. */
const NON_SELECTIVE_COST = 1;

function rate(entry: Pick<QueryPlanEntry, 'operation' | 'relativeCost'>): QueryPlanRating {
  if (entry.operation === 'Unknown') return 'unknown';
  // A full table scan degrades as the object grows regardless of today's cost estimate.
  if (entry.operation === 'TableScan') return 'critical';
  if (entry.relativeCost !== null && entry.relativeCost >= NON_SELECTIVE_COST) return 'warning';
  return 'good';
}

type Draft = Omit<QueryPlanEntry, 'rating'>;

function newDraft(event: LogEvent): Draft {
  return {
    lineNo: event.lineNo,
    sourceLine: sourceLineOf(event),
    // Last field is the query text; earlier ones are `[12]` and `Aggregations:0`.
    text: (event.fields[event.fields.length - 1] ?? '').trim(),
    rows: null,
    operation: 'Unknown',
    object: null,
    fieldsUsed: [],
    cardinality: null,
    sobjectCardinality: null,
    relativeCost: null,
  };
}

function applyExplain(draft: Draft, event: LogEvent): void {
  const detail = event.fields[event.fields.length - 1] ?? '';
  const match = EXPLAIN_RE.exec(detail);
  if (!match) return;
  const [, operation, object, fieldsRaw, cardinality, sobjectCardinality, relativeCost] = match;
  draft.operation = operation as QueryPlanOperation;
  draft.object = object;
  draft.fieldsUsed = fieldsRaw
    ? fieldsRaw
        .split(',')
        .map((f) => f.trim())
        .filter(Boolean)
    : [];
  draft.cardinality = Number(cardinality);
  draft.sobjectCardinality = Number(sobjectCardinality);
  draft.relativeCost = Number(relativeCost);
}

/**
 * SOQL executes synchronously and a statement cannot start before the
 * previous one finishes, so BEGIN → [EXPLAIN] → END is always contiguous for
 * a given query — a single "current" pointer is enough, no line-marker
 * matching needed. A query left open by a truncated log is still emitted
 * (with `rows: null`) rather than silently dropped.
 */
export function extractQueryPlans(events: LogEvent[]): QueryPlanEntry[] {
  const out: QueryPlanEntry[] = [];
  let current: Draft | null = null;

  const flush = () => {
    if (current) out.push({ ...current, rating: rate(current) });
    current = null;
  };

  for (const event of events) {
    if (event.event === 'SOQL_EXECUTE_BEGIN') {
      flush();
      current = newDraft(event);
      continue;
    }
    if (event.event === 'SOQL_EXECUTE_EXPLAIN' && current) {
      applyExplain(current, event);
      continue;
    }
    if (event.event === 'SOQL_EXECUTE_END' && current) {
      const rowsField = event.fields.find((f) => ROWS_RE.test(f));
      current.rows = rowsField ? Number(ROWS_RE.exec(rowsField)?.[1] ?? 0) : null;
      flush();
      continue;
    }
  }
  flush();

  return out;
}

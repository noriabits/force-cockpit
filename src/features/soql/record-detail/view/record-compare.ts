// PURE, DOM-free — lines several loaded records of ONE object up field by field
// and says which fields differ. The pane (record-compare.tsx) owns everything
// that is not a loaded record: a column still loading, one that failed, one that
// turned out to be another object. This only ever sees records that are there.
//
// Decisions worth knowing:
//  - Nothing is skipped. `Id` and the audit fields differ by construction and so
//    head every comparison with Only differences on, but a skip list is a hidden
//    rule, and `LastModifiedDate` differing is genuinely useful.
//  - A field one record's describe omits while another declares it with a value
//    reads as a real difference with a blank cell. `hiddenFields` is also empty
//    when the field list was unavailable, so the two are not separable; with the
//    same object and the same user it is near-impossible in practice.
//  - FLS-hidden fields never appear: they live in `hiddenFields`, not `fields`.
import type { RecordDetailData, RecordDetailField } from '../../../../shared/protocol';
import { displayValue } from './record-edits';

export interface CompareColumn {
  name: string;
  id: string;
}

export interface CompareRow {
  name: string;
  label: string;
  type: string;
  /** One per column, in column order. */
  values: string[];
  /** Per column: differs from the FIRST column (the baseline). Index 0 is always false. */
  differsFromFirst: boolean[];
  /** The values are not all equal. */
  differs: boolean;
}

export interface Comparison {
  /** 1:1 with the input array and in the same order — the caller maps a column back to its tab. */
  columns: CompareColumn[];
  /** After `onlyDifferences` and the text filter. */
  rows: CompareRow[];
  /** Rows surviving `onlyDifferences`, before the text filter — the filter counter's denominator. */
  shown: number;
  /** Differing fields across the whole union. */
  differing: number;
  /** Union size. */
  total: number;
}

/** Key-sorted JSON, so two structurally equal objects stringify identically. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const body = Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
    return `{${body.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/**
 * The value reduced to something comparable. Null, undefined and absent are one
 * thing — except on a checkbox, where absent is `false` (as `toRawValue` reads
 * it), or an absent checkbox against a real `false` would be flagged as a
 * difference while both cells display `false`.
 */
function canonical(field: RecordDetailField, value: unknown): string {
  if (field.type === 'boolean') return `boolean:${value === true}`;
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'object') return `object:${stableStringify(value)}`;
  return `${typeof value}:${String(value)}`;
}

/** What a cell reads as. Objects use the same key order the comparison does. */
function cellText(field: RecordDetailField, value: unknown): string {
  if (value && typeof value === 'object') return stableStringify(value);
  return displayValue(field, value);
}

function matches(row: CompareRow, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return [row.label, row.name, row.type, ...row.values].some((s) => s.toLowerCase().includes(q));
}

/** The union of every record's fields by API name; the first record to declare one supplies it. */
function unionFields(records: RecordDetailData[]): RecordDetailField[] {
  const byName = new Map<string, RecordDetailField>();
  for (const rec of records) {
    for (const field of rec.fields) if (!byName.has(field.name)) byName.set(field.name, field);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function buildComparison(
  records: { name: string; record: RecordDetailData }[],
  opts: { onlyDifferences: boolean; filter: string },
): Comparison {
  const recs = records.map((r) => r.record);
  const all: CompareRow[] = unionFields(recs).map((field) => {
    const tokens = recs.map((rec) => canonical(field, rec.values[field.name]));
    return {
      name: field.name,
      label: field.label,
      type: field.type,
      values: recs.map((rec) => cellText(field, rec.values[field.name])),
      differsFromFirst: tokens.map((t) => t !== tokens[0]),
      differs: tokens.some((t) => t !== tokens[0]),
    };
  });
  const eligible = opts.onlyDifferences ? all.filter((r) => r.differs) : all;
  return {
    columns: records.map((r) => ({ name: r.name, id: r.record.id })),
    rows: eligible.filter((r) => matches(r, opts.filter)),
    shown: eligible.length,
    differing: all.filter((r) => r.differs).length,
    total: all.length,
  };
}

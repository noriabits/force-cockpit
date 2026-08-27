/**
 * Pure SELECT-clause editing for the field browser panel. Locates the SELECT
 * item list and turns "add/remove this field" into an `{ start, end, text }`
 * edit the caller applies with `textarea.setRangeText(...)`, rather than
 * returning a rewritten query string.
 *
 * Editing-not-rewriting is deliberate: rebuilding the whole SELECT clause on
 * every checkbox click would reflow a query the user hand-formatted across
 * multiple lines, and would fight the textarea's own undo stack. Every other
 * programmatic write in this feature (autocomplete's `choose`, keyword-case)
 * follows the same `setRangeText` contract.
 *
 * DOM-free and dependency-free (besides the shared literal-skipping helpers
 * `tab-name.ts` also borrows) so it can be unit-tested directly.
 */

import { inRanges, stringRanges } from '../autocomplete/soql-context';

export interface SelectItem {
  /** The item's own trimmed text, e.g. `Owner.Name` or `(SELECT Id FROM Contacts)`. */
  text: string;
  start: number;
  end: number;
}

export interface SelectClause {
  /** Index right after the SELECT keyword. */
  listStart: number;
  /** Index of the top-level FROM keyword, or end of text when there isn't one yet. */
  listEnd: number;
  items: SelectItem[];
}

export interface Edit {
  start: number;
  end: number;
  text: string;
}

/**
 * A field/relationship path a checkbox can represent: `Name`, `Owner.Name`.
 * Anything else in the SELECT list — a subquery, `toLabel(Status)`, an alias,
 * `FIELDS(ALL)` — has no checkbox and is left untouched by every edit below.
 */
const SIMPLE_FIELD_PATH = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;

/** Paren depth open at `index`, ignoring characters inside quoted literals. */
function parenDepthAt(text: string, index: number, ranges: [number, number][]): number {
  let depth = 0;
  for (let i = 0; i < index; i++) {
    if (inRanges(ranges, i)) continue;
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && depth > 0) depth--;
  }
  return depth;
}

/**
 * First match of `re` that sits at paren depth 0 and outside a string literal,
 * at or after `from`. A subquery's own SELECT/FROM must never be mistaken for
 * the outer clause's.
 */
function firstTopLevelMatch(
  text: string,
  re: RegExp,
  ranges: [number, number][],
  from: number,
): RegExpExecArray | null {
  re.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index < from) continue;
    if (!inRanges(ranges, m.index) && parenDepthAt(text, m.index, ranges) === 0) return m;
  }
  return null;
}

/** Trim `[rawStart, rawEnd)` to its non-whitespace span and record it, dropping blanks. */
function pushTrimmedItem(
  items: SelectItem[],
  text: string,
  rawStart: number,
  rawEnd: number,
): void {
  let start = rawStart;
  let end = rawEnd;
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  if (start === end) return; // a leading/trailing/doubled comma mid-edit — nothing to record
  items.push({ text: text.slice(start, end), start, end });
}

/** Split `[listStart, listEnd)` on top-level commas, skipping parens and string literals. */
function splitItems(
  text: string,
  listStart: number,
  listEnd: number,
  ranges: [number, number][],
): SelectItem[] {
  const items: SelectItem[] = [];
  let depth = 0;
  let itemStart = listStart;
  for (let i = listStart; i < listEnd; i++) {
    if (inRanges(ranges, i)) continue;
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')' && depth > 0) depth--;
    else if (ch === ',' && depth === 0) {
      pushTrimmedItem(items, text, itemStart, i);
      itemStart = i + 1;
    }
  }
  pushTrimmedItem(items, text, itemStart, listEnd);
  return items;
}

/**
 * Locates the SELECT item list: from the top-level SELECT keyword to the
 * top-level FROM keyword (or end of text, mid-edit before FROM is typed).
 * Returns null only when there is no SELECT at all.
 */
export function parseSelectClause(soql: string): SelectClause | null {
  const ranges = stringRanges(soql);
  const selectMatch = firstTopLevelMatch(soql, /\bSELECT\b/gi, ranges, 0);
  if (!selectMatch) return null;

  const listStart = selectMatch.index + selectMatch[0].length;
  const fromMatch = firstTopLevelMatch(soql, /\bFROM\b/gi, ranges, listStart);
  const listEnd = fromMatch ? fromMatch.index : soql.length;

  return { listStart, listEnd, items: splitItems(soql, listStart, listEnd, ranges) };
}

/** The simple field/relationship paths already in the SELECT list, lowercased. */
export function selectedFieldSet(soql: string): Set<string> {
  const set = new Set<string>();
  const clause = parseSelectClause(soql);
  if (!clause) return set;
  for (const item of clause.items) {
    if (SIMPLE_FIELD_PATH.test(item.text)) set.add(item.text.toLowerCase());
  }
  return set;
}

/**
 * Edit to append `field` to the SELECT list, or null when there is no SELECT
 * to edit or the field is already present (case-insensitively).
 *
 * A bare `COUNT()` is replaced rather than appended to — `SELECT COUNT(), Id`
 * is not valid SOQL, and a `COUNT()` query has nothing else to preserve.
 */
export function addFieldEdit(soql: string, field: string): Edit | null {
  const clause = parseSelectClause(soql);
  if (!clause) return null;
  if (selectedFieldSet(soql).has(field.toLowerCase())) return null;

  const { items, listStart } = clause;
  if (items.length === 1 && items[0].text.toUpperCase() === 'COUNT()') {
    return { start: items[0].start, end: items[0].end, text: field };
  }
  if (items.length === 0) {
    return { start: listStart, end: listStart, text: ' ' + field };
  }
  const last = items[items.length - 1];
  return { start: last.end, end: last.end, text: ', ' + field };
}

/**
 * Edit to drop `field` from the SELECT list (consuming its neighbouring comma
 * and whitespace), or null when it isn't a bare item there, or it is the only
 * item — SOQL requires at least one selected field.
 */
export function removeFieldEdit(soql: string, field: string): Edit | null {
  const clause = parseSelectClause(soql);
  if (!clause || clause.items.length <= 1) return null;

  const idx = clause.items.findIndex(
    (item) => SIMPLE_FIELD_PATH.test(item.text) && item.text.toLowerCase() === field.toLowerCase(),
  );
  if (idx === -1) return null;

  const item = clause.items[idx];
  if (idx === 0) {
    const next = clause.items[idx + 1];
    return { start: item.start, end: next.start, text: '' };
  }
  const prev = clause.items[idx - 1];
  return { start: prev.end, end: item.end, text: '' };
}

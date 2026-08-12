/**
 * Pure SOQL cursor-context analysis for autocomplete. Given the full query text
 * and the cursor offset, decides what should be suggested: sObject names (after
 * FROM), field/relationship names (in SELECT / WHERE / ORDER BY / GROUP BY /
 * HAVING), or picklist values (inside a quoted literal compared against a field).
 * DOM-free and dependency-free so it can be unit-tested directly.
 */

import { SOQL_CLAUSES } from '../soql-keywords';

export type SoqlContext =
  | { kind: 'none' }
  | { kind: 'object'; token: string; replaceStart: number; replaceEnd: number }
  | {
      kind: 'field';
      fromObject: string;
      relationshipPath: string[];
      token: string;
      replaceStart: number;
      replaceEnd: number;
      // The governing clause (SELECT/WHERE/GROUP/ORDER/HAVING) — the autocomplete
      // layer needs this to know FIELDS(ALL)/STANDARD/CUSTOM only belong in SELECT.
      clause: string;
    }
  | {
      kind: 'picklist';
      fromObject: string;
      pickField: string;
      token: string;
      replaceStart: number;
      replaceEnd: number;
    };

// Derived from the shared vocabulary so the tokenizer and the autocomplete can
// never disagree about what a clause keyword is.
const CLAUSE_PATTERNS: { clause: string; re: RegExp }[] = SOQL_CLAUSES.map(({ key, words }) => ({
  clause: key,
  re: new RegExp(`\\b${words.split(/\s+/).join('\\s+')}\\b`, 'gi'),
}));

const FIELD_CLAUSES = new Set(['SELECT', 'WHERE', 'GROUP', 'ORDER', 'HAVING']);

/** Character ranges covered by single-quoted literals, as [start, end) pairs. */
export function stringRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  let open = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "'" || text[i - 1] === '\\') continue;
    if (open < 0) open = i;
    else {
      ranges.push([open, i + 1]);
      open = -1;
    }
  }
  if (open >= 0) ranges.push([open, text.length]);
  return ranges;
}

/**
 * True when `index` sits inside a quoted literal. Keyword scanning must skip
 * those — a query like `WHERE Name LIKE '%with%'` otherwise reads the literal's
 * "with" as a WITH clause and stops offering field suggestions after it.
 */
export function inRanges(ranges: [number, number][], index: number): boolean {
  return ranges.some(([start, end]) => index >= start && index < end);
}

/** Last identifier-ish token (incl. dots) ending at `pos`. */
function tokenBefore(text: string, pos: number): { token: string; start: number } {
  let start = pos;
  while (start > 0 && /[A-Za-z0-9_.]/.test(text[start - 1])) start--;
  return { token: text.slice(start, pos), start };
}

/** The clause keyword governing the cursor (the nearest one before it). */
function currentClause(before: string): string | null {
  const strings = stringRanges(before);
  let best: { clause: string; index: number } | null = null;
  for (const { clause, re } of CLAUSE_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let last = -1;
    while ((m = re.exec(before)) !== null) {
      if (!inRanges(strings, m.index)) last = m.index;
    }
    if (last >= 0 && (!best || last > best.index)) best = { clause, index: last };
  }
  return best?.clause ?? null;
}

/** First object named after FROM, or null. */
function fromObjectOf(text: string): string | null {
  const strings = stringRanges(text);
  const re = /\bFROM\s+([A-Za-z0-9_]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (!inRanges(strings, m.index)) return m[1];
  }
  return null;
}

/** True when the cursor sits inside an unterminated single-quoted string. */
function insideString(before: string): boolean {
  let count = 0;
  for (let i = 0; i < before.length; i++) {
    if (before[i] === "'" && before[i - 1] !== '\\') count++;
  }
  return count % 2 === 1;
}

export function analyzeSoql(text: string, cursor: number): SoqlContext {
  const before = text.slice(0, cursor);
  const fromObject = fromObjectOf(text);

  // ── Picklist: typing inside a quoted literal compared against a field ──────
  if (insideString(before) && fromObject) {
    const openQuote = before.lastIndexOf("'");
    const lhs = before.slice(0, openQuote);
    const cmp = /([A-Za-z0-9_.]+)\s*(?:=|!=|>=|<=|>|<|\bLIKE\b|\bIN\b)\s*\(?\s*$/i.exec(lhs);
    if (cmp) {
      const fieldPath = cmp[1].split('.');
      return {
        kind: 'picklist',
        fromObject,
        pickField: fieldPath[fieldPath.length - 1],
        token: text.slice(openQuote + 1, cursor),
        replaceStart: openQuote + 1,
        replaceEnd: cursor,
      };
    }
    return { kind: 'none' };
  }

  const clause = currentClause(before);
  const { token: fullToken, start } = tokenBefore(text, cursor);

  // ── Object names: after FROM, before any further clause ───────────────────
  if (clause === 'FROM') {
    return {
      kind: 'object',
      token: fullToken,
      replaceStart: start,
      replaceEnd: cursor,
    };
  }

  // ── Field / relationship names ────────────────────────────────────────────
  if (clause && FIELD_CLAUSES.has(clause) && fromObject) {
    const segments = fullToken.split('.');
    const token = segments.pop() ?? '';
    const replaceStart = cursor - token.length;
    return {
      kind: 'field',
      fromObject,
      relationshipPath: segments,
      token,
      replaceStart,
      replaceEnd: cursor,
      clause,
    };
  }

  return { kind: 'none' };
}

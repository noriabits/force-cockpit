/**
 * Pure SOQL cursor-context analysis for autocomplete. Given the full query text
 * and the cursor offset, decides what should be suggested: sObject names (after
 * FROM), field/relationship names (in SELECT / WHERE / ORDER BY / GROUP BY /
 * HAVING), or picklist values (inside a quoted literal compared against a field).
 * DOM-free and dependency-free so it can be unit-tested directly.
 */

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
    }
  | {
      kind: 'picklist';
      fromObject: string;
      pickField: string;
      token: string;
      replaceStart: number;
      replaceEnd: number;
    };

const CLAUSE_PATTERNS: { clause: string; re: RegExp }[] = [
  { clause: 'SELECT', re: /\bSELECT\b/gi },
  { clause: 'FROM', re: /\bFROM\b/gi },
  { clause: 'WHERE', re: /\bWHERE\b/gi },
  { clause: 'GROUP', re: /\bGROUP\s+BY\b/gi },
  { clause: 'ORDER', re: /\bORDER\s+BY\b/gi },
  { clause: 'HAVING', re: /\bHAVING\b/gi },
  { clause: 'LIMIT', re: /\bLIMIT\b/gi },
];

const FIELD_CLAUSES = new Set(['SELECT', 'WHERE', 'GROUP', 'ORDER', 'HAVING']);

/** Last identifier-ish token (incl. dots) ending at `pos`. */
function tokenBefore(text: string, pos: number): { token: string; start: number } {
  let start = pos;
  while (start > 0 && /[A-Za-z0-9_.]/.test(text[start - 1])) start--;
  return { token: text.slice(start, pos), start };
}

/** The clause keyword governing the cursor (the nearest one before it). */
function currentClause(before: string): string | null {
  let best: { clause: string; index: number } | null = null;
  for (const { clause, re } of CLAUSE_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let last = -1;
    while ((m = re.exec(before)) !== null) last = m.index;
    if (last >= 0 && (!best || last > best.index)) best = { clause, index: last };
  }
  return best?.clause ?? null;
}

/** First object named after FROM, or null. */
function fromObjectOf(text: string): string | null {
  const m = /\bFROM\s+([A-Za-z0-9_]+)/i.exec(text);
  return m ? m[1] : null;
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
    };
  }

  return { kind: 'none' };
}

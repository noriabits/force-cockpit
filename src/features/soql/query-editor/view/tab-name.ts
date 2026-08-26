/**
 * Names a query tab after the object it queries — `Order`, `Order (1)`,
 * `Order (2)` — instead of the meaningless `Query 1`, `Query 2` counter.
 * Pure and DOM-free; the tab strip calls it whenever the active tab's text changes.
 *
 * Only the SOQL-specific half lives here: what a query's base name *is*. The
 * de-duplication and rename rules are shared with every other tab strip — see
 * `src/features/shared/view/tab-naming.ts`. The wrappers below keep this
 * module's original query-shaped signatures, so callers pass SOQL text and never
 * have to derive the base themselves.
 *
 * Deliberately independent of `fromObjectOfQuery` in ../soqlErrorParser: that one
 * takes the first textual FROM, which in a parent-child query is the *subquery's*
 * object. For a label we want the outer one.
 */

// Shares the exact literal-range logic `soql-context.ts`'s clause scanning
// uses, so both modules agree on what a quoted string hides from view.
import { stringRanges, inRanges } from './autocomplete/soql-context';
import {
  cloneName,
  deriveName,
  shouldRevertToAuto as baseShouldRevertToAuto,
} from '../../../shared/view/tab-naming';

/** Base name for a query with no object to name it after. */
const FALLBACK_BASE = 'Query';

/** What the old auto-numbering produced, before tabs were named after their object. */
const LEGACY_AUTO_NAME = /^Query \d+$/;

const FROM_OBJECT = /\bFROM\s+([A-Za-z0-9_]+)/gi;

/**
 * The object named in the query's top-level FROM clause, or null when there isn't
 * one yet. Matches inside parentheses are skipped, so a subquery's FROM never
 * beats the outer one: `SELECT Id, (SELECT Id FROM Contacts) FROM Account` → `Account`.
 * Casing is whatever the user typed.
 */
export function queryObjectName(soql: string): string | null {
  if (!soql) return null;
  FROM_OBJECT.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FROM_OBJECT.exec(soql)) !== null) {
    if (parenDepthAt(soql, match.index) === 0) return match[1];
  }
  return null;
}

/**
 * How many parentheses are still open at `index`. Parens inside a quoted
 * literal (e.g. `LIKE '%(VIP%'`) are skipped — an unmatched one there would
 * otherwise desync the count and hide a real top-level FROM that follows.
 */
function parenDepthAt(text: string, index: number): number {
  const ranges = stringRanges(text);
  let depth = 0;
  for (let i = 0; i < index; i++) {
    if (inRanges(ranges, i)) continue;
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && depth > 0) depth--;
  }
  return depth;
}

/** Label a query wants before de-duplication: its FROM object, or `Query`. */
export function baseNameFor(soql: string): string {
  return queryObjectName(soql) ?? FALLBACK_BASE;
}

/** {@link deriveName} over a query's FROM object. */
export function deriveTabName(soql: string, otherNames: string[], currentName?: string): string {
  return deriveName(baseNameFor(soql), otherNames, currentName);
}

/** {@link baseShouldRevertToAuto} over a query's FROM object. */
export function shouldRevertToAuto(soql: string, nameObject: string | null | undefined): boolean {
  return baseShouldRevertToAuto(baseNameFor(soql), nameObject);
}

/** {@link cloneName} — re-exported so tabs.js has one naming import. */
export const cloneTabName = cloneName;

/**
 * True for names the pre-object auto-numbering produced. Tabs persisted before
 * this feature carry no auto/manual flag, so this is what tells a leftover
 * `Query 3` (safe to re-derive) from a name the user actually chose.
 */
export function isLegacyAutoName(name: string): boolean {
  return LEGACY_AUTO_NAME.test(name);
}

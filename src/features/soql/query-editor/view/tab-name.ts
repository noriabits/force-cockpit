/**
 * Names a query tab after the object it queries — `Order`, `Order (1)`,
 * `Order (2)` — instead of the meaningless `Query 1`, `Query 2` counter.
 * Pure and DOM-free; tabs.js calls it whenever the active tab's text changes.
 *
 * Deliberately independent of `fromObjectOfQuery` in ../soqlErrorParser: that one
 * takes the first textual FROM, which in a parent-child query is the *subquery's*
 * object. For a label we want the outer one.
 */

// Shares the exact literal-range logic `soql-context.ts`'s clause scanning
// uses, so both modules agree on what a quoted string hides from view.
import { stringRanges, inRanges } from './autocomplete/soql-context';

/** Base name for a query with no object to name it after. */
const FALLBACK_BASE = 'Query';

/** What the old auto-numbering produced, before tabs were named after their object. */
const LEGACY_AUTO_NAME = /^Query \d+$/;

const FROM_OBJECT = /\bFROM\s+([A-Za-z0-9_]+)/gi;

/** Escapes a base name for embedding in the ` (n)` suffix pattern. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Strips a trailing ` (n)` suffix, if present, back to the base it was numbered from. */
const TRAILING_SUFFIX = /^(.*) \(\d+\)$/;
function nameBase(name: string): string {
  const match = TRAILING_SUFFIX.exec(name);
  return match ? match[1] : name;
}

/** `base` itself if free, else the first free ` (n)` suffix — case-insensitive. */
function firstFreeName(base: string, otherNames: string[]): string {
  const used = new Set(otherNames.map((n) => n.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 1; ; n++) {
    const name = `${base} (${n})`;
    if (!used.has(name.toLowerCase())) return name;
  }
}

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

/**
 * The label a tab should carry, given the names the *other* tabs already use.
 *
 * `currentName` is kept untouched when it already belongs to the same base
 * (`Order`, `Order (2)`), so editing a WHERE clause never renumbers a tab. New
 * names take the first free slot — bare base first, then ` (1)`, ` (2)`… — which
 * means closing `Order` frees the bare name for the next Order tab.
 *
 * Object names are matched case-insensitively (`Asset` and `asset` are the same
 * sObject to Salesforce), but the winning name always keeps the exact casing the
 * user typed for *this* tab's query.
 */
export function deriveTabName(soql: string, otherNames: string[], currentName?: string): string {
  const base = baseNameFor(soql);
  if (currentName && belongsToBase(currentName, base)) return currentName;
  return firstFreeName(base, otherNames);
}

/**
 * Whether a tab whose name was adopted from a saved query should hand itself
 * back to auto-naming. It should once the query stops targeting the object the
 * name was adopted for: a tab loaded as `Open cases` and then rewritten to
 * `SELECT Id FROM Lead` is no longer that saved query, so the label misleads.
 * Editing the same object's query (a WHERE clause, a LIMIT) keeps the label.
 *
 * A name the user typed by hand carries no `nameObject` and so never reverts —
 * that one they chose deliberately.
 *
 * Compared case-insensitively, like every other object-name comparison here.
 */
export function shouldRevertToAuto(soql: string, nameObject: string | null | undefined): boolean {
  if (!nameObject) return false;
  return baseNameFor(soql).toLowerCase() !== nameObject.toLowerCase();
}

/**
 * The name a clone of a tab named `name` should get, numbered to the first
 * free slot — `asset` clones to `asset (1)`, `asset (1)` clones to `asset (2)`
 * once `(1)` is taken, etc. Independent of the query text, so a
 * manually-renamed tab clones under its own name rather than the FROM object.
 *
 * `isAutoName` decides whether a trailing ` (n)` on `name` is stripped before
 * renumbering: for an auto-derived name it's the dedup suffix `firstFreeName`
 * itself added, safe to strip and recompute. For a name the user typed by hand
 * a trailing ` (n)` is just part of the name they chose (e.g. `"Invoices
 * (2024)"`) — stripping it would silently rename the clone.
 */
export function cloneTabName(name: string, otherNames: string[], isAutoName: boolean): string {
  const base = isAutoName ? nameBase(name) : name;
  return firstFreeName(base, otherNames);
}

/** Whether `name` is this base's bare or suffixed form (case-insensitive). */
function belongsToBase(name: string, base: string): boolean {
  return new RegExp(`^${escapeRegExp(base)}(?: \\(\\d+\\))?$`, 'i').test(name);
}

/**
 * True for names the pre-object auto-numbering produced. Tabs persisted before
 * this feature carry no auto/manual flag, so this is what tells a leftover
 * `Query 3` (safe to re-derive) from a name the user actually chose.
 */
export function isLegacyAutoName(name: string): boolean {
  return LEGACY_AUTO_NAME.test(name);
}

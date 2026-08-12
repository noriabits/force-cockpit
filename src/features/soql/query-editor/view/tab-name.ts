/**
 * Names a query tab after the object it queries — `Order`, `Order (1)`,
 * `Order (2)` — instead of the meaningless `Query 1`, `Query 2` counter.
 * Pure and DOM-free; tabs.js calls it whenever the active tab's text changes.
 *
 * Deliberately independent of `fromObjectOfQuery` in ../soqlErrorParser: that one
 * takes the first textual FROM, which in a parent-child query is the *subquery's*
 * object. For a label we want the outer one.
 */

/** Base name for a query with no object to name it after. */
const FALLBACK_BASE = 'Query';

/** What the old auto-numbering produced, before tabs were named after their object. */
const LEGACY_AUTO_NAME = /^Query \d+$/;

const FROM_OBJECT = /\bFROM\s+([A-Za-z0-9_]+)/gi;

/** Escapes a base name for embedding in the ` (n)` suffix pattern. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

/** How many parentheses are still open at `index`. */
function parenDepthAt(text: string, index: number): number {
  let depth = 0;
  for (let i = 0; i < index; i++) {
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

  const used = new Set(otherNames.map((n) => n.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 1; ; n++) {
    const name = `${base} (${n})`;
    if (!used.has(name.toLowerCase())) return name;
  }
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

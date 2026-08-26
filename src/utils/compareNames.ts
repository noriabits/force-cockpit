/**
 * Shared alphabetical comparator for named YAML items (scripts, monitoring configs).
 *
 * Two things the default `a.name.localeCompare(b.name)` gets wrong here:
 *
 * 1. **Leading symbols/emoji sort before digits and letters.** Script names in the
 *    wild are routinely prefixed with an emoji ("🔥 CPU pressure"), so a list of
 *    them ends up ordered by emoji codepoint — which reads as random — and
 *    prefixing a name with "0" or "A" to pin it to the top does nothing, because
 *    every emoji still sorts ahead of it. Comparison therefore starts at the first
 *    alphanumeric character, so the order matches the label as a human reads it.
 * 2. **"Step 10" sorted before "Step 2".** Numeric-aware collation fixes that.
 *
 * Case-insensitive (`sensitivity: 'base'`), with the raw name as the tiebreak so
 * two names differing only in their prefix keep a stable, deterministic order.
 */
const COLLATION: Intl.CollatorOptions = { numeric: true, sensitivity: 'base' };

/** Leading characters that are neither a letter nor a digit in any script. */
const LEADING_NON_ALPHANUMERIC = /^[^\p{L}\p{N}]+/u;

function sortKey(name: string): string {
  const stripped = name.replace(LEADING_NON_ALPHANUMERIC, '').trim();
  // A name made entirely of symbols still needs something to compare on.
  return stripped || name;
}

/** Compare two display names alphabetically. */
export function compareNames(a: string, b: string): number {
  const cmp = sortKey(a).localeCompare(sortKey(b), undefined, COLLATION);
  return cmp !== 0 ? cmp : a.localeCompare(b, undefined, COLLATION);
}

/** `Array.prototype.sort` comparator for any item carrying a `name`. */
export function compareByName(a: { name: string }, b: { name: string }): number {
  return compareNames(a.name, b.name);
}

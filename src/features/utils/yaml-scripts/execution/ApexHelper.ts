// Renders JS values as Apex literals for `js` scripts that build Apex by hand,
// and is also the one escaping function `PlaceholderResolver`'s `${...}`
// substitution uses for `apex:`/`gather:` code — see `escapeApexString`.
//
// The placeholder layer escapes a script's inputs for JS, not for the Apex that
// script goes on to generate, so a value carrying an apostrophe would otherwise
// break out of its Apex string literal and land as code in executeAnonymous.

/**
 * Escapes a string for safe use inside an Apex single-quoted string literal.
 * Backslash escaping, matching Salesforce's own `String.escapeSingleQuotes`.
 * Apex reads `''` as two adjacent literals with no `+` between them (a compile
 * error), so doubling — the SQL/Pascal convention — would not compile.
 */
export function escapeApexString(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** Escapes a string and wraps it in Apex single quotes. */
function quote(s: string): string {
  return `'${escapeApexString(s)}'`;
}

/**
 * Renders a value as an Apex literal: strings quoted and escaped, numbers and
 * booleans bare, objects and arrays serialized to quoted JSON (ready for
 * JSON.deserializeUntyped), and empty or missing values as `null`.
 */
export function apexValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'object') return quote(JSON.stringify(value));
  return quote(String(value));
}

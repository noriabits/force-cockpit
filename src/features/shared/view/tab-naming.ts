/**
 * Naming rules shared by every tab strip (SOQL query tabs, REST request tabs).
 *
 * A tab's label is a *base name* — whatever the feature derives from the tab's
 * content (the FROM object, the endpoint's last segment) — de-duplicated against
 * the names the other tabs already carry: bare base first, then ` (1)`, ` (2)`…
 *
 * Pure and DOM-free. Each feature supplies its own `baseNameFor`; everything
 * below is about de-duplication and about when a name may change, which is the
 * same for every strip.
 */

/** Strips a trailing ` (n)` suffix, if present, back to the base it was numbered from. */
const TRAILING_SUFFIX = /^(.*) \(\d+\)$/;

/** Escapes a base name for embedding in the ` (n)` suffix pattern. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function nameBase(name: string): string {
  const match = TRAILING_SUFFIX.exec(name);
  return match ? match[1] : name;
}

/** `base` itself if free, else the first free ` (n)` suffix — case-insensitive. */
export function firstFreeName(base: string, otherNames: string[]): string {
  const used = new Set(otherNames.map((n) => n.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 1; ; n++) {
    const name = `${base} (${n})`;
    if (!used.has(name.toLowerCase())) return name;
  }
}

/** Whether `name` is this base's bare or suffixed form (case-insensitive). */
export function belongsToBase(name: string, base: string): boolean {
  return new RegExp(`^${escapeRegExp(base)}(?: \\(\\d+\\))?$`, 'i').test(name);
}

/**
 * The label a tab should carry, given `base` and the names the *other* tabs use.
 *
 * `currentName` is kept untouched when it already belongs to the same base
 * (`Order`, `Order (2)`), so editing a WHERE clause — or a query string on an
 * endpoint — never renumbers a tab. New names take the first free slot, which
 * means closing `Order` frees the bare name for the next Order tab.
 *
 * Bases are matched case-insensitively, but the winning name always keeps the
 * exact casing this tab's own content produced.
 */
export function deriveName(base: string, otherNames: string[], currentName?: string): string {
  if (currentName && belongsToBase(currentName, base)) return currentName;
  return firstFreeName(base, otherNames);
}

/**
 * Whether a tab whose name was adopted from a saved entry should hand itself
 * back to auto-naming. It should once its content stops matching the base the
 * name was adopted for: a tab loaded as `Open cases` and then rewritten to
 * `SELECT Id FROM Lead` is no longer that saved query, so the label misleads.
 * Editing within the same base (a WHERE clause, a request body) keeps the label.
 *
 * A name the user typed by hand carries no anchor and so never reverts — that
 * one they chose deliberately.
 */
export function shouldRevertToAuto(
  currentBase: string,
  anchor: string | null | undefined,
): boolean {
  if (!anchor) return false;
  return currentBase.toLowerCase() !== anchor.toLowerCase();
}

/**
 * The name a clone of a tab named `name` should get, numbered to the first free
 * slot — `asset` clones to `asset (1)`, `asset (1)` to `asset (2)` once `(1)` is
 * taken. Independent of the tab's content, so a manually-renamed tab clones
 * under its own name.
 *
 * `isAutoName` decides whether a trailing ` (n)` on `name` is stripped before
 * renumbering: for an auto-derived name it's the dedup suffix `firstFreeName`
 * itself added, safe to strip and recompute. For a name the user typed by hand a
 * trailing ` (n)` is just part of the name they chose (e.g. `"Invoices (2024)"`)
 * — stripping it would silently rename the clone.
 */
export function cloneName(name: string, otherNames: string[], isAutoName: boolean): string {
  const base = isAutoName ? nameBase(name) : name;
  return firstFreeName(base, otherNames);
}

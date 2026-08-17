/**
 * Match ranking for the SOQL autocomplete dropdown. Pure, DOM-free, unit-tested.
 *
 * Salesforce describe results come back in whatever order the org returns them
 * (roughly declaration order), not relevance order. Filtering with a plain
 * substring test then keeps that order — so typing "City" could surface
 * "Vlocity_cmt__City__c" (a mid-string match) ahead of "City__c" (a prefix
 * match) just because it happens to sort earlier in the describe response.
 *
 * API names are segmented (`Vlocity_cmt__City__c`, `BillingCity`), and a hit on
 * a segment boundary is what the user meant far more often than a hit buried
 * inside a word — typing "city" should not rank `Vlocity_cmt__MeterId__r`
 * (matching the "city" inside the *namespace*) alongside `Vlocity_cmt__City__c`.
 * So every occurrence is scored and the best one wins, not just the first.
 */

/** Rank tiers, lowest (best) first. */
const EXACT = 0;
const PREFIX = 1;
const SEGMENT = 2; // starts a `_`-delimited or camelCase segment
const MIDWORD = 3;

/**
 * Is position `idx` the start of a segment within `candidate`? True after an
 * underscore/dot separator, or at a camelCase hump ("Billing|City").
 */
function isSegmentStart(candidate: string, idx: number): boolean {
  const prev = candidate[idx - 1];
  if (prev === '_' || prev === '.') return true;
  return /[a-z0-9]/.test(prev) && /[A-Z]/.test(candidate[idx]);
}

/**
 * Lower is better. `null` means `candidate` does not contain `token` at all.
 * The best-scoring occurrence of the token decides the rank.
 */
export function matchRank(token: string, candidate: string): number | null {
  if (!token) return EXACT;
  const t = token.toLowerCase();
  const c = candidate.toLowerCase();
  let best: number | null = null;
  for (let idx = c.indexOf(t); idx !== -1; idx = c.indexOf(t, idx + 1)) {
    let rank;
    if (idx === 0) rank = t.length === c.length ? EXACT : PREFIX;
    else rank = isSegmentStart(candidate, idx) ? SEGMENT : MIDWORD;
    if (rank === EXACT) return EXACT;
    if (best === null || rank < best) best = rank;
  }
  return best;
}

/** Case-insensitive substring test, for call sites that don't need ordering. */
export function matchesToken(token: string, candidate: string): boolean {
  return matchRank(token, candidate) !== null;
}

/**
 * Filters `items` to those whose `getText(item)` matches `token`, sorted by
 * match quality (exact, then prefix, then segment, then mid-word) and
 * alphabetically within a tier. Non-matching items are dropped.
 */
export function filterAndRankByMatch<T>(
  items: T[],
  token: string,
  getText: (item: T) => string,
): T[] {
  const ranked: { item: T; rank: number; text: string }[] = [];
  for (const item of items) {
    const text = getText(item);
    const rank = matchRank(token, text);
    if (rank !== null) ranked.push({ item, rank, text });
  }
  ranked.sort((a, b) => a.rank - b.rank || a.text.localeCompare(b.text));
  return ranked.map((r) => r.item);
}

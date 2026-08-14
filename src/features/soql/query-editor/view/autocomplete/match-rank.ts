/**
 * Match ranking for the SOQL autocomplete dropdown. Pure, DOM-free, unit-tested.
 *
 * Salesforce describe results come back in whatever order the org returns them
 * (roughly declaration order), not relevance order. Filtering with a plain
 * substring test then keeps that order — so typing "City" could surface
 * "Vlocity_cmt__City__c" (a mid-string match) ahead of "City__c" (a prefix
 * match) just because it happens to sort earlier in the describe response.
 */

/** Lower is better. `null` means `candidate` does not contain `token` at all. */
export function matchRank(token: string, candidate: string): number | null {
  if (!token) return 0;
  const t = token.toLowerCase();
  const c = candidate.toLowerCase();
  const idx = c.indexOf(t);
  if (idx === -1) return null;
  if (idx === 0) return t.length === c.length ? 0 : 1; // exact match vs. prefix match
  return 2; // token appears mid-string
}

/** Case-insensitive substring test, for call sites that don't need ordering. */
export function matchesToken(token: string, candidate: string): boolean {
  return matchRank(token, candidate) !== null;
}

/**
 * Filters `items` to those whose `getText(item)` matches `token`, sorted by
 * match quality (exact, then prefix, then mid-string) and alphabetically
 * within a tier. Non-matching items are dropped.
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

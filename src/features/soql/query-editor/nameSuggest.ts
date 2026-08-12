/**
 * "Did you mean…?" ranking for API names. Pure, dependency-free, unit-tested.
 * Used by {@link SoqlDiagnosticsService} to turn a rejected field/object name into
 * a short list of plausible corrections.
 */

/**
 * Optimal string alignment distance — Levenshtein plus adjacent transpositions.
 * Plain Levenshtein charges 2 for a swap, which would reject `Nmae` → `Name`,
 * the single most common way an API name gets mistyped.
 */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;

  /** rows[i][j] = distance between a[0..i) and b[0..j) */
  let twoBack: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, twoBack[j - 2] + 1);
      }
      row.push(value);
      if (value < best) best = value;
    }
    if (best > max) return max + 1;
    twoBack = prev;
    prev = row;
  }
  return prev[b.length];
}

/** Lower is better. `null` means "not close enough to suggest". */
function score(target: string, candidate: string, max: number): number | null {
  if (candidate === target) return 0;
  if (candidate.startsWith(target) || target.startsWith(candidate)) return 1;
  if (candidate.includes(target) || target.includes(candidate)) return 2;
  const distance = editDistance(target, candidate, max);
  return distance <= max ? 2 + distance : null;
}

/**
 * Candidates closest to `target`, best first. Matching is case-insensitive but the
 * returned strings keep the candidates' original casing (they are API names the
 * user will paste back into a query).
 */
export function suggestNames(target: string, candidates: string[], max = 5): string[] {
  const needle = target.toLowerCase();
  if (!needle) return [];
  // Roughly one edit per three characters. Short names get exactly one: at two or
  // three characters almost everything is within two edits of everything else.
  const tolerance = needle.length <= 4 ? 1 : Math.max(2, Math.floor(needle.length * 0.4));

  const ranked: { name: string; rank: number }[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const rank = score(needle, key, tolerance);
    if (rank !== null) ranked.push({ name: candidate, rank });
  }

  return ranked
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
    .slice(0, max)
    .map((r) => r.name);
}

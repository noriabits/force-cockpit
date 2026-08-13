// Pulls the final query out of the model's answer so the panel can offer a
// one-click "Run query". Pure and defensive, like the debug-log tab's
// parseLevelSuggestion: the model can emit anything, and a malformed block must
// simply mean "no proposal" rather than breaking the panel.

export interface SoqlProposal {
  query: string;
  useToolingApi: boolean;
}

// [\s\S] rather than the `s` flag so the query may span lines. Non-greedy so
// the first closing fence ends the block.
const SOQL_FENCE_RE = /```soql[ \t]*\r?\n([\s\S]*?)```/gi;
const META_FENCE_RE = /```soql-meta[ \t]*\r?\n([\s\S]*?)```/i;

/**
 * The LAST ` ```soql ` block in the answer, plus the Tooling flag from an
 * optional ` ```soql-meta ` JSON block. The last block wins because the model
 * may show intermediate drafts on its way to the final answer — a clarifying
 * reply carries no block at all and yields `null`.
 */
export function parseProposal(answer: string): SoqlProposal | null {
  let query = '';
  for (const match of answer.matchAll(SOQL_FENCE_RE)) {
    const candidate = match[1].trim();
    if (candidate) query = candidate;
  }
  if (!query) return null;

  return { query, useToolingApi: parseToolingFlag(answer) };
}

function parseToolingFlag(answer: string): boolean {
  const match = META_FENCE_RE.exec(answer);
  if (!match) return false;
  try {
    const parsed: unknown = JSON.parse(match[1].trim());
    if (typeof parsed !== 'object' || parsed === null) return false;
    return (parsed as Record<string, unknown>).useToolingApi === true;
  } catch {
    // A malformed meta block carries no information — fall back to the default
    // rather than discarding an otherwise perfectly good query.
    return false;
  }
}

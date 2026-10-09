// One raw log body → everything the viewer renders. Shared by the Debug Logs
// tab (an ApexLog fetched from the org) and the ▶️ Apex tab (the log an
// Execute Anonymous call hands back), so both read a log the same way.
import type { ParsedLog } from '../types';
import { buildExecutionTree, pruneDepth } from './executionTree';
import { detectIssues } from './issueDetector';
import { parseLog } from './logLine';
import { buildSummary } from './logSummary';
import { extractQueryPlans } from './queryPlan';

/** Above this, the parsed events are not shipped to the webview in full. */
const MAX_INLINE_BYTES = 5 * 1024 * 1024;
/** Depth kept when the tree is sent to the webview / the model. */
const MAX_TREE_DEPTH = 12;

export interface AnalyzedLog {
  /** Set when the log was too large to ship in full; only head/tail lines are present. */
  partial: boolean;
  totalLines: number;
  parsed: ParsedLog;
}

export function analyzeLog(body: string): AnalyzedLog {
  const { header, events } = parseLog(body);
  const summary = buildSummary(events, body);
  const issues = detectIssues(events, summary);
  const tree = pruneDepth(buildExecutionTree(events), MAX_TREE_DEPTH);
  const queryPlans = extractQueryPlans(events);

  const partial = body.length > MAX_INLINE_BYTES;
  const shipped = partial ? [...events.slice(0, 2000), ...events.slice(-2000)] : events;

  return {
    partial,
    totalLines: events.length,
    parsed: { header, events: shipped, summary, issues, tree, queryPlans },
  };
}

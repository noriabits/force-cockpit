// Builds the Developer-Console-style call tree from the entry/exit event pairs,
// with total and self time per node. Pure: events in, tree out.
import type { ExecNode, LogEvent } from '../types';

const ENTER = new Set(['CODE_UNIT_STARTED', 'METHOD_ENTRY', 'CONSTRUCTOR_ENTRY']);
const EXIT = new Set(['CODE_UNIT_FINISHED', 'METHOD_EXIT', 'CONSTRUCTOR_EXIT']);

/** The human-readable name of an entry event: its last non-marker field. */
function nameOf(event: LogEvent): string {
  const meaningful = event.fields.filter((f) => f && !/^\[(\d+|EXTERNAL)\]$/.test(f));
  // CODE_UNIT_STARTED often ends with an internal typeRef (`__sfdc_trigger/X`);
  // the field before it is the readable label.
  if (meaningful.length > 1 && meaningful[meaningful.length - 1].startsWith('__sfdc_')) {
    return meaningful[meaningful.length - 2];
  }
  return meaningful[meaningful.length - 1] ?? event.event;
}

function nanosToMs(nanos: number): number {
  return Math.round(nanos / 1e5) / 10;
}

/**
 * Pair entry/exit events into a forest. Unbalanced logs (truncated, or levels
 * that log an entry without its exit) are tolerated: unclosed nodes simply keep
 * a null duration.
 */
export function buildExecutionTree(events: LogEvent[]): ExecNode[] {
  const roots: ExecNode[] = [];
  const stack: { node: ExecNode; startNanos: number | null }[] = [];

  for (const event of events) {
    if (ENTER.has(event.event)) {
      const node: ExecNode = {
        name: nameOf(event),
        kind: event.event === 'CODE_UNIT_STARTED' ? 'codeUnit' : 'method',
        lineNo: event.lineNo,
        startNanos: event.nanos,
        totalMs: null,
        selfMs: null,
        children: [],
      };
      const parent = stack[stack.length - 1];
      if (parent) parent.node.children.push(node);
      else roots.push(node);
      stack.push({ node, startNanos: event.nanos });
      continue;
    }
    if (EXIT.has(event.event) && stack.length > 0) {
      const frame = stack.pop();
      if (!frame) continue;
      if (frame.startNanos !== null && event.nanos !== null) {
        frame.node.totalMs = nanosToMs(event.nanos - frame.startNanos);
      }
    }
  }

  computeSelfTimes(roots);
  return roots;
}

function computeSelfTimes(nodes: ExecNode[]): void {
  for (const node of nodes) {
    computeSelfTimes(node.children);
    if (node.totalMs === null) continue;
    const childTotal = node.children.reduce((sum, c) => sum + (c.totalMs ?? 0), 0);
    node.selfMs = Math.round((node.totalMs - childTotal) * 10) / 10;
  }
}

/** Depth-first flattening, used for the "slowest units" ranking. */
export function flattenTimings(nodes: ExecNode[]): ExecNode[] {
  const out: ExecNode[] = [];
  const walk = (list: ExecNode[]) => {
    for (const node of list) {
      out.push(node);
      walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/** Drop deep levels so a huge tree stays renderable/token-cheap. */
export function pruneDepth(nodes: ExecNode[], maxDepth: number): ExecNode[] {
  if (maxDepth <= 0) return [];
  return nodes.map((node) => ({
    ...node,
    children: pruneDepth(node.children, maxDepth - 1),
  }));
}

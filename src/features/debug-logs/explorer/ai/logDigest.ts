// Builds the compact briefing the model receives instead of the raw log.
//
// Debug logs reach 20 MB — orders of magnitude past any context window. The
// digest carries the facts that matter (metadata, what was captured, limits,
// detected issues, errors with context, debug output) within a character
// budget, and the model pulls anything else it needs through the log tools.
import type { ApexLogRow, LogEvent, LogIssue, LogSummary, ParsedLog } from '../types';

/** Roughly 10k characters ≈ a few thousand tokens, leaving room for the conversation. */
const DEFAULT_DIGEST_BUDGET = 10_000;

interface DigestInput {
  row: ApexLogRow | null;
  parsed: ParsedLog;
  totalLines: number;
  budget?: number;
}

function formatLimits(summary: LogSummary): string {
  if (summary.limits.length === 0) return '_No limit data captured (ApexProfiling was off)._';
  return summary.limits
    .slice()
    .sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0))
    .map((l) => `- ${l.name}: ${l.used} / ${l.max}${l.percent === null ? '' : ` (${l.percent}%)`}`)
    .join('\n');
}

function formatIssues(issues: LogIssue[]): string {
  if (issues.length === 0) return '_No heuristic issues detected._';
  return issues
    .map((i) => {
      const where = i.lineNo === null ? '' : ` (L${i.lineNo})`;
      const evidence = i.evidence.length ? `\n  evidence: ${i.evidence[0]}` : '';
      return `- [${i.severity}] ${i.rule}${where}: ${i.title}${evidence}`;
    })
    .join('\n');
}

function formatErrors(summary: LogSummary, events: LogEvent[]): string {
  if (summary.exceptions.length === 0) return '_No exceptions in the log._';
  return summary.exceptions
    .slice(0, 5)
    .map((ex) => {
      const context = contextAround(events, ex.lineNo, 8);
      return `### L${ex.lineNo} — ${ex.message}\n\`\`\`\n${context}\n\`\`\``;
    })
    .join('\n\n');
}

/** ±`radius` raw lines around a line number, prefixed with their line numbers. */
function contextAround(events: LogEvent[], lineNo: number, radius: number): string {
  const index = events.findIndex((e) => e.lineNo === lineNo);
  if (index < 0) return '';
  const from = Math.max(0, index - radius);
  const to = Math.min(events.length, index + radius + 1);
  return events
    .slice(from, to)
    .map((e) => `L${e.lineNo} ${e.raw}`)
    .join('\n');
}

/** All USER_DEBUG output, middle-truncated when it dominates the budget. */
function formatDebugOutput(events: LogEvent[], budget: number): string {
  const lines: string[] = [];
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.event !== 'USER_DEBUG') continue;
    lines.push(`L${event.lineNo} ${event.fields[event.fields.length - 1] ?? ''}`);
    // Keep the continuation lines of a multi-line System.debug together.
    for (let j = i + 1; j < events.length && !events[j].event; j++) {
      lines.push(events[j].raw);
    }
  }
  if (lines.length === 0) return '_No System.debug output captured._';

  const joined = lines.join('\n');
  if (joined.length <= budget) return joined;
  const half = Math.floor(budget / 2);
  return (
    joined.slice(0, half) +
    `\n… [${lines.length} debug lines, middle omitted — use search_log / read_log_lines] …\n` +
    joined.slice(-half)
  );
}

function formatSlowest(summary: LogSummary): string {
  if (summary.slowestUnits.length === 0) return '_No timing data captured._';
  return summary.slowestUnits
    .slice(0, 15)
    .map((u) => `- ${u.name} — self ${u.selfMs}ms / total ${u.totalMs}ms (L${u.lineNo})`)
    .join('\n');
}

export function buildLogDigest(input: DigestInput): string {
  const { row, parsed, totalLines } = input;
  const budget = input.budget ?? DEFAULT_DIGEST_BUDGET;
  const { summary, events, header } = parsed;

  const meta = row
    ? [
        `- Operation: ${row.operation}`,
        `- Status: ${row.status}`,
        `- Request: ${row.request} / ${row.application}`,
        `- User: ${row.logUserName}`,
        `- Duration: ${row.durationMilliseconds} ms`,
        `- Size: ${row.logLength} bytes`,
        `- Started: ${row.startTime}`,
      ].join('\n')
    : '_Log metadata unavailable._';

  const captured = header
    ? Object.entries(header.levels)
        .map(([category, level]) => `${category}=${level}`)
        .join(', ')
    : 'unknown';

  const counts = summary.counts;
  const sections = [
    `## Log metadata\n${meta}`,
    `## Captured log levels\nAPI v${header?.apiVersion ?? '?'} — ${captured}\n` +
      `Anything not listed at a sufficient level is simply absent from this log; say so rather ` +
      `than concluding it did not happen.`,
    `## Totals\n- ${totalLines} log lines\n- SOQL ${counts.soql}, SOSL ${counts.sosl}, ` +
      `DML ${counts.dml}, callouts ${counts.callouts}, query rows ${counts.rows}\n` +
      `- USER_DEBUG lines ${counts.userDebug}, exceptions ${counts.exceptions}\n` +
      `- Truncated: ${summary.truncated ? 'YES — the end of the transaction is missing' : 'no'}`,
    `## Governor limits\n${formatLimits(summary)}`,
    `## Heuristic issues detected by Force Cockpit\n${formatIssues(parsed.issues)}`,
    `## Slowest code units\n${formatSlowest(summary)}`,
    `## Errors\n${formatErrors(summary, events)}`,
    `## System.debug output\n\`\`\`\n${formatDebugOutput(events, Math.floor(budget * 0.4))}\n\`\`\``,
  ];

  return sections.join('\n\n');
}

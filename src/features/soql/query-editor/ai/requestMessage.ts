// Builds one turn's user message: the request, preceded by what the user
// currently has on screen — the query in the editor and the outcome of the last
// run. Pure and vscode-free, so it is unit-tested directly and the webview
// bundle can import MAX_RESULT_ROWS from it without dragging anything in.
//
// Everything here is a bounded SAMPLE, not the data. Result sets reach 2000
// rows; the model gets the shape plus the real totals and is told to query for
// more if it needs it, rather than being handed a payload that would blow the
// context window.
import { stripRecordAttributes } from '../../../../utils/salesforce';

/** Rows sampled from the last run. Also what the webview slices to before posting. */
export const MAX_RESULT_ROWS = 10;
/** Hard ceiling on the serialized sample, whatever the row count. */
const MAX_RESULT_CHARS = 4000;
/** The editor pre-fills a new tab with this; it carries no intent worth sending. */
const PLACEHOLDER_QUERY = 'SELECT ID FROM';

/** The outcome of the user's last run in the active tab — results or an error, never both. */
export interface LastRun {
  /** The query that produced this outcome; may differ from the editor if they have since edited it. */
  query?: string;
  useToolingApi?: boolean;
  /** Verbatim Salesforce error, when the run failed. */
  error?: string;
  records?: Record<string, unknown>[];
  /** The org's real count, which the sampled `records` may be far short of. */
  totalSize?: number;
}

export interface RequestMessageInput {
  question: string;
  currentQuery?: string;
  currentUseToolingApi?: boolean;
  lastRun?: LastRun | null;
}

export function buildRequestMessage(req: RequestMessageInput): string {
  const blocks = [buildCurrentQueryBlock(req), buildLastRunBlock(req.lastRun)].filter(Boolean);
  return [...blocks, `## Request\n${req.question}`].join('\n\n');
}

function buildCurrentQueryBlock(req: RequestMessageInput): string {
  const current = (req.currentQuery ?? '').trim();
  // An untouched new tab is noise, not context.
  if (!current || current.replace(/\s+/g, ' ').toUpperCase() === PLACEHOLDER_QUERY) return '';
  const api = req.currentUseToolingApi ? 'Tooling API' : 'Standard API';
  return `## Current query in the editor\n(set to run against the ${api})\n\`\`\`soql\n${current}\n\`\`\``;
}

function buildLastRunBlock(lastRun?: LastRun | null): string {
  if (!lastRun) return '';
  const ranQuery = (lastRun.query ?? '').trim();
  // Name the query only when it is not simply what is already in the editor block.
  const ran = ranQuery ? `\nThey ran:\n\`\`\`soql\n${ranQuery}\n\`\`\`` : '';

  if (lastRun.error) {
    return `## The user's last run FAILED${ran}\nSalesforce returned:\n\`\`\`\n${lastRun.error}\n\`\`\``;
  }

  const records = lastRun.records;
  if (!records) return '';

  const total = lastRun.totalSize ?? records.length;
  if (records.length === 0) {
    return `## The user's last run returned NO ROWS${ran}\nThe query is valid but matched nothing.`;
  }

  const { sample, shown } = sampleRows(records);
  const columns = Object.keys(sample[0] ?? {});
  const scope =
    shown < total
      ? `Showing the first ${shown} of ${total} row(s) — a sample, not the whole result.`
      : `All ${total} row(s).`;

  return (
    `## The user's last run returned ${total} row(s)${ran}\n` +
    `Columns: ${columns.join(', ')}\n${scope}\n` +
    `\`\`\`json\n${JSON.stringify(sample, null, 2)}\n\`\`\``
  );
}

/**
 * Up to MAX_RESULT_ROWS rows, dropped further if serializing them would blow
 * MAX_RESULT_CHARS — one very wide row is worth more than a truncated blob the
 * model cannot parse as JSON.
 */
function sampleRows(records: Record<string, unknown>[]): {
  sample: Record<string, unknown>[];
  shown: number;
} {
  let sample = stripRecordAttributes(records.slice(0, MAX_RESULT_ROWS));
  while (sample.length > 1 && JSON.stringify(sample).length > MAX_RESULT_CHARS) {
    sample = sample.slice(0, sample.length - 1);
  }
  return { sample, shown: sample.length };
}

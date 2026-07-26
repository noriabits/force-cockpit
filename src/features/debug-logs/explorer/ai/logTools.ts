// Tools that let the model read the parts of the log the digest left out. The
// full body stays here on the host; the model can only ask for slices of it.
import type { ExecNode, LogEvent } from '../types';
import { stringArg, type ToolHandler } from '../../../../services/ai/tools/ToolHandler';
import { pruneDepth } from '../parsing/executionTree';

const MAX_MATCHES = 40;
const MAX_SLICE_LINES = 400;

function numberArg(input: Record<string, unknown>, name: string, fallback: number): number {
  const value = input[name];
  const parsed = typeof value === 'number' ? value : Number(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** `search_log` — regex over the raw log, returning line numbers and snippets. */
export function createSearchLogTool(events: LogEvent[]): ToolHandler {
  return {
    spec: {
      name: 'search_log',
      description:
        'Search the full debug log with a case-insensitive regular expression and get back ' +
        'matching line numbers with their text. Use this to find events the summary omitted ' +
        '(a specific SOQL statement, a class name, a flow element, a variable value). ' +
        'Results are capped — narrow the pattern if you need more.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description:
              'A case-insensitive regular expression, e.g. "SOQL_EXECUTE_BEGIN" or "MyClass\\.".',
          },
          maxMatches: {
            type: 'number',
            description: `Maximum matches to return (default and cap ${MAX_MATCHES}).`,
          },
        },
        required: ['pattern'],
      },
    },
    run(input, append) {
      const pattern = stringArg(input, 'pattern');
      if (!pattern) return 'Error: no search pattern provided.';
      let re: RegExp;
      try {
        re = new RegExp(pattern, 'i');
      } catch (err) {
        return `Error: invalid regular expression: ${(err as Error).message}`;
      }
      const cap = Math.min(numberArg(input, 'maxMatches', MAX_MATCHES), MAX_MATCHES);
      append(`\n\n[search_log] /${pattern}/\n`);
      const matches: { line: number; text: string }[] = [];
      let total = 0;
      for (const event of events) {
        if (!re.test(event.raw)) continue;
        total++;
        if (matches.length < cap) {
          matches.push({ line: event.lineNo, text: event.raw.slice(0, 400) });
        }
      }
      append(`→ ${total} match(es)${total > matches.length ? ' (truncated)' : ''}\n\n`);
      return JSON.stringify({ pattern, totalMatches: total, matches }, null, 2);
    },
  };
}

/** `read_log_lines` — a raw slice of the log, for reading around a match. */
export function createReadLogLinesTool(events: LogEvent[]): ToolHandler {
  return {
    spec: {
      name: 'read_log_lines',
      description:
        'Read a slice of the raw debug log by line number, to see the context around ' +
        `something search_log found. At most ${MAX_SLICE_LINES} lines per call.`,
      inputSchema: {
        type: 'object',
        properties: {
          start: { type: 'number', description: 'First line number to read (1-based).' },
          end: { type: 'number', description: 'Last line number to read (inclusive).' },
        },
        required: ['start', 'end'],
      },
    },
    run(input, append) {
      const start = Math.max(1, Math.floor(numberArg(input, 'start', 1)));
      const requestedEnd = Math.floor(numberArg(input, 'end', start + 50));
      const end = Math.min(requestedEnd, start + MAX_SLICE_LINES - 1, events.length);
      if (end < start) return 'Error: "end" must be greater than or equal to "start".';
      append(`\n\n[read_log_lines] L${start}–L${end}\n`);
      const slice = events
        .slice(start - 1, end)
        .map((e) => `L${e.lineNo} ${e.raw}`)
        .join('\n');
      append(`→ ${end - start + 1} line(s)\n\n`);
      return slice || '(no lines in that range)';
    },
  };
}

/** `get_execution_tree` — the call tree with timings, as JSON. */
export function createExecutionTreeTool(tree: ExecNode[]): ToolHandler {
  return {
    spec: {
      name: 'get_execution_tree',
      description:
        'Get the transaction call tree (code units and methods) with total and self times in ' +
        'milliseconds. Use this to find where the time went before proposing performance fixes.',
      inputSchema: {
        type: 'object',
        properties: {
          maxDepth: {
            type: 'number',
            description: 'How many levels of the tree to return (default 4).',
          },
        },
        required: [],
      },
    },
    run(input, append) {
      const depth = Math.max(1, Math.min(numberArg(input, 'maxDepth', 4), 12));
      append(`\n\n[get_execution_tree] depth ${depth}\n`);
      const pruned = pruneDepth(tree, depth);
      append(`→ ${pruned.length} root node(s)\n\n`);
      return JSON.stringify(pruned, null, 2);
    },
  };
}

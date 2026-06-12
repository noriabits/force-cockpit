import type { ConnectionManager } from '../../../../../salesforce/connection';
import { stripRecordAttributes } from '../../../../../utils/salesforce';
import { assertApexSuccess, filterUserDebugLines } from '../../../../apexUtils';
import type { ExecuteScriptResult, GatherSpec, YamlScript } from '../../types';
import type { ChatMessage, LmGateway, ToolCall, ToolSpec } from './types';

const MAX_TOOL_ROUNDS = 6;

function recordsToJson(records: unknown[]): string {
  return JSON.stringify(stripRecordAttributes(records), null, 2);
}

const RUN_SOQL_TOOL: ToolSpec = {
  name: 'run_soql',
  description:
    'Run a read-only SOQL query against the connected Salesforce org and get the matching ' +
    'records back as JSON. Use this only when you need additional data to complete the ' +
    'analysis. Only SELECT/SOQL queries are supported — no data can be modified.',
  inputSchema: {
    type: 'object',
    properties: {
      soql: {
        type: 'string',
        description: 'A SOQL SELECT query, e.g. "SELECT Id, Name FROM Account LIMIT 10".',
      },
    },
    required: ['soql'],
  },
};

const SYSTEM_PREAMBLE =
  'You are a Salesforce data analyst embedded in the Force Cockpit VS Code extension. ' +
  'You are given the result of a fixed data-gathering step and a task. Analyse the data ' +
  'and respond with a clear, concise written analysis. You cannot modify data. If a ' +
  'read-only follow-up query tool is provided and you genuinely need more data, you may ' +
  'call it; otherwise answer directly from the data given.';

/**
 * Executes an `ai` script: runs the fixed gather step via ConnectionManager,
 * then drives the language model (through the injected gateway) to analyse the
 * result. The model never executes anything itself — it can only propose a
 * read-only `run_soql` follow-up which this executor runs on its behalf.
 */
export class AiExecutor {
  constructor(
    private readonly connectionManager: ConnectionManager,
    private readonly gateway: LmGateway,
  ) {}

  async execute(
    script: YamlScript,
    signal?: AbortSignal,
    onLogChunk?: (chunk: string) => void,
  ): Promise<ExecuteScriptResult> {
    let transcript = '';
    const append = (s: string) => {
      transcript += s;
      onLogChunk?.(s);
    };

    try {
      if (!script.gather) {
        throw new Error('AI script has no gather step.');
      }

      this.throwIfAborted(signal);
      append('# Gathering data\n');
      const gathered = await this.runGather(script.gather);
      append(gathered + '\n\n');

      const messages: ChatMessage[] = [
        {
          role: 'user',
          text: `${SYSTEM_PREAMBLE}\n\n## Task\n${script.script}\n\n## Gathered data\n${gathered}`,
        },
      ];
      const tools = script.allowFollowupQueries ? [RUN_SOQL_TOOL] : [];

      append('# Analysis\n');
      await this.runAnalysisLoop(script, messages, tools, signal, append);

      return {
        scriptId: script.id,
        success: true,
        message: `AI script "${script.name}" completed.`,
        debugLog: transcript,
      };
    } catch (err) {
      const errorMsg = (err as Error).message;
      if (errorMsg === 'Operation cancelled') {
        return { scriptId: script.id, success: false, message: '', debugLog: '', cancelled: true };
      }
      append(`\n--- error ---\n${errorMsg}`);
      return { scriptId: script.id, success: false, message: errorMsg, debugLog: transcript };
    }
  }

  // ── Gather step ─────────────────────────────────────────────────────────

  private async runGather(gather: GatherSpec): Promise<string> {
    if (gather.kind === 'soql') {
      const result = await this.connectionManager.query(gather.value);
      return recordsToJson(result.records);
    }
    // apex | apex-file → run anonymous Apex; the data is the debug output.
    const apexResult = await this.connectionManager.executeAnonymousWithDebugLog(gather.value, {
      logLevels: { Apex_code: 'DEBUG' },
    });
    assertApexSuccess(apexResult);
    const debugLog = apexResult.debugLog ?? '';
    const userDebug = filterUserDebugLines(debugLog);
    return userDebug.trim() ? userDebug : debugLog;
  }

  // ── Analysis loop ───────────────────────────────────────────────────────

  private async runAnalysisLoop(
    script: YamlScript,
    messages: ChatMessage[],
    tools: ToolSpec[],
    signal: AbortSignal | undefined,
    append: (s: string) => void,
  ): Promise<void> {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      this.throwIfAborted(signal);

      let assistantText = '';
      const toolCalls: ToolCall[] = [];
      for await (const event of this.gateway.send(
        { modelId: script.model, messages, tools },
        signal,
      )) {
        if (event.kind === 'text') {
          assistantText += event.text;
          append(event.text);
        } else {
          toolCalls.push(event.call);
        }
      }

      messages.push({
        role: 'assistant',
        text: assistantText,
        ...(toolCalls.length ? { toolCalls } : {}),
      });

      if (toolCalls.length === 0) return;

      for (const call of toolCalls) {
        this.throwIfAborted(signal);
        const result = await this.runToolCall(call, append);
        messages.push({ role: 'toolResult', callId: call.callId, content: result });
      }
    }
    append('\n\n[Reached the maximum number of follow-up query rounds.]');
  }

  private async runToolCall(call: ToolCall, append: (s: string) => void): Promise<string> {
    if (call.name !== 'run_soql') {
      return `Error: unknown tool "${call.name}".`;
    }
    const soql = String(call.input.soql ?? '').trim();
    if (!soql) {
      return 'Error: no SOQL query provided.';
    }
    // Defense in depth: ConnectionManager.query only runs SOQL (read-only),
    // but reject anything that does not look like a SELECT so the model cannot
    // be coaxed into a non-query payload.
    if (!/^select\b/i.test(soql)) {
      return 'Error: only read-only SELECT/SOQL queries are allowed.';
    }
    append(`\n\n[run_soql] ${soql}\n`);
    try {
      const result = await this.connectionManager.query(soql);
      append(`→ ${result.records.length} record(s)\n\n`);
      return recordsToJson(result.records);
    } catch (err) {
      const msg = (err as Error).message;
      append(`→ error: ${msg}\n\n`);
      return `Error running query: ${msg}`;
    }
  }

  private throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw new Error('Operation cancelled');
  }
}

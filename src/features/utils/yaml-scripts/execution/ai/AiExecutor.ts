import type { ConnectionManager } from '../../../../../salesforce/connection';
import type { DescribeService } from '../../../../../services/describe/DescribeService';
import {
  AiConversation,
  DEFAULT_MAX_TOOL_ROUNDS,
  raceAbort,
  throwIfAborted,
  type ModelFallback,
} from '../../../../../services/ai/AiConversation';
import {
  createCurrentUserTool,
  createDescribeObjectTool,
  createRunSoqlTool,
  recordsToJson,
} from '../../../../../services/ai/tools/orgTools';
import { type ToolHandler } from '../../../../../services/ai/tools/ToolHandler';
import {
  createReadWorkspaceFileTool,
  createSearchWorkspaceFilesTool,
} from '../../../../../services/ai/tools/workspaceTools';
import {
  buildSkillsCatalogue,
  createReadSkillTool,
} from '../../../../../services/ai/tools/skillTools';
import type { ChatMessage, LmGateway, WorkspaceSearch } from '../../../../../services/ai/types';
import { assertApexSuccess, filterUserDebugLines } from '../../../../../services/apex/apexUtils';
import { DEFAULT_APEX_LOG_LEVELS } from '../defaultApexLogLevels';
import type { SkillInfo, SkillsRepository } from '../../../../../services/skills/SkillsRepository';
import type { ExecuteScriptResult, GatherSpec, YamlScript } from '../../types';

const COMMON_GUIDANCE =
  'You cannot modify data. ' +
  'Before writing any SOQL query, call describe_object to verify which fields are available ' +
  '— never invent or guess field API names. If a follow-up query tool is ' +
  'provided and you genuinely need more data, you may call it. ' +
  'If asked about "my"/"I"/"me" access or field-level security, call get_current_user first ' +
  "— describe_object already reflects that specific user's permissions, but you cannot say so " +
  'without knowing who they are. ' +
  `You have a hard budget of ${DEFAULT_MAX_TOOL_ROUNDS} tool-call rounds for this task; spend them ` +
  'sparingly and prioritise the queries that matter most, because once the budget is ' +
  'exhausted you must answer with whatever data you already have.';

// Used when the script defines a fixed gather (data) step.
const GATHER_PREAMBLE =
  'You are a Salesforce data analyst embedded in the Force Cockpit VS Code extension. ' +
  'You are given the result of a fixed data-gathering step and a task. Analyse the data ' +
  'and respond with a clear, concise written analysis. ' +
  COMMON_GUIDANCE +
  ' Otherwise answer directly from the data given. ' +
  'Finally, whenever you needed an on-demand follow-up query to complete the analysis, ' +
  'end your response with a short "## Suggested gather improvements" section: describe how ' +
  'the fixed gather step (its SOQL or Apex) could be extended so that the same data would ' +
  'be available up front next time, avoiding the extra round trip. Omit this section if no ' +
  'follow-up queries were needed, otherwise provide the suggestions.';

// Used for input/prompt-only scripts that have no gather step.
const NO_GATHER_PREAMBLE =
  'You are a Salesforce assistant embedded in the Force Cockpit VS Code extension. ' +
  'You are given a task to complete using the tools provided and the connected Salesforce ' +
  'org. Respond with a clear, concise written answer. ' +
  COMMON_GUIDANCE;

/**
 * Executes an `ai` script: runs the fixed gather step via ConnectionManager,
 * then drives the language model (through the shared AiConversation) to analyse
 * the result. The model never executes anything itself — it can only propose a
 * tool call which this executor runs on its behalf.
 */
export class AiExecutor {
  private readonly conversation: AiConversation;

  constructor(
    private readonly connectionManager: ConnectionManager,
    gateway: LmGateway,
    private readonly skills: SkillsRepository,
    private readonly describeService: DescribeService,
    private readonly workspaceSearch?: WorkspaceSearch,
  ) {
    this.conversation = new AiConversation(gateway);
  }

  async execute(
    script: YamlScript,
    signal?: AbortSignal,
    onLogChunk?: (chunk: string) => void,
    onModelFallback?: (fallback: ModelFallback) => void,
  ): Promise<ExecuteScriptResult> {
    let transcript = '';
    const append = (s: string) => {
      transcript += s;
      onLogChunk?.(s);
    };

    try {
      throwIfAborted(signal);

      // The gather (data) step is optional — a script may be driven purely by
      // its prompt and user inputs.
      let gatheredSection = '';
      if (script.gather) {
        append('# Gathering data\n');
        const gathered = await raceAbort(this.runGather(script.gather), signal);
        // Fence the raw data dump so it renders as a clean code block in the
        // Markdown preview (SOQL → pretty JSON; apex → debug-log text).
        const fenceLang = script.gather.kind === 'soql' ? 'json' : '';
        append('```' + fenceLang + '\n' + gathered + '\n```\n\n');
        gatheredSection = `\n\n## Gathered data\n${gathered}`;
      }

      const selectedSkills = this.resolveSelectedSkills(script.skills);
      const skillsSection = buildSkillsCatalogue(selectedSkills);
      const preamble = script.gather ? GATHER_PREAMBLE : NO_GATHER_PREAMBLE;

      const messages: ChatMessage[] = [
        {
          role: 'user',
          text: `${preamble}\n\n## Task\n${script.script}${skillsSection}${gatheredSection}`,
        },
      ];
      const tools: ToolHandler[] = [
        createDescribeObjectTool(this.describeService),
        createCurrentUserTool(this.connectionManager),
        ...(selectedSkills.length ? [createReadSkillTool(this.skills)] : []),
        ...(script.allowFollowupQueries ? [createRunSoqlTool(this.connectionManager)] : []),
        ...(script.allowReadWorkspaceFiles && this.workspaceSearch
          ? [
              createSearchWorkspaceFilesTool(this.workspaceSearch),
              createReadWorkspaceFileTool(this.workspaceSearch),
            ]
          : []),
      ];

      append('# Analysis\n');
      const { fallback } = await this.conversation.run({
        modelId: script.model,
        messages,
        tools,
        append,
        signal,
        onModelFallback,
      });

      return {
        scriptId: script.id,
        success: true,
        message: `AI script "${script.name}" completed.`,
        debugLog: transcript,
        ...(fallback ? { modelFallback: fallback } : {}),
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
      logLevels: DEFAULT_APEX_LOG_LEVELS,
    });
    assertApexSuccess(apexResult);
    const debugLog = apexResult.debugLog ?? '';
    const userDebug = filterUserDebugLines(debugLog);
    return userDebug.trim() ? userDebug : debugLog;
  }

  // ── Skills ──────────────────────────────────────────────────────────────

  /** The catalogue entries for the script's selected skills that still exist on disk. */
  private resolveSelectedSkills(skillIds: string[] | undefined): SkillInfo[] {
    if (!skillIds?.length) return [];
    const available = new Map(this.skills.listSkills().map((s) => [s.id, s]));
    return skillIds.map((id) => available.get(id)).filter((s): s is SkillInfo => !!s);
  }
}

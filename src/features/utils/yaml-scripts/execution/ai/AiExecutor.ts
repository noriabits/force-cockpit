import type { ConnectionManager } from '../../../../../salesforce/connection';
import type { DescribeService } from '../../../../../services/DescribeService';
import { stripRecordAttributes } from '../../../../../utils/salesforce';
import { assertApexSuccess, filterUserDebugLines } from '../../../../apexUtils';
import type { SkillInfo, SkillsRepository } from '../../skills/SkillsRepository';
import type { ExecuteScriptResult, GatherSpec, YamlScript } from '../../types';
import type { ChatMessage, LmGateway, ToolCall, ToolSpec, WorkspaceSearch } from './types';

const MAX_TOOL_ROUNDS = 150;

function recordsToJson(records: unknown[]): string {
  return JSON.stringify(stripRecordAttributes(records), null, 2);
}

const DESCRIBE_OBJECT_TOOL: ToolSpec = {
  name: 'describe_object',
  description:
    'Get the list of available fields for a Salesforce object. Call this before writing ' +
    'any SOQL query to confirm which fields exist — never invent or guess field API names.',
  inputSchema: {
    type: 'object',
    properties: {
      objectName: {
        type: 'string',
        description:
          'The API name of the Salesforce object, e.g. "Account", "Opportunity", "My_Object__c".',
      },
    },
    required: ['objectName'],
  },
};

const READ_SKILL_TOOL: ToolSpec = {
  name: 'read_skill',
  description:
    'Read the full content of one of the available skills (a markdown playbook with ' +
    'domain guidance) by its id. Call this when a listed skill is relevant to the task ' +
    'before writing your analysis. Returns the skill body as markdown.',
  inputSchema: {
    type: 'object',
    properties: {
      skillId: {
        type: 'string',
        description: 'The id of the skill to read, taken from the "Available skills" list.',
      },
    },
    required: ['skillId'],
  },
};

const RUN_SOQL_TOOL: ToolSpec = {
  name: 'run_soql',
  description:
    'Run a SOQL query against the connected Salesforce org and get the matching ' +
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

const SEARCH_WORKSPACE_FILES_TOOL: ToolSpec = {
  name: 'search_workspace_files',
  description:
    'Search the workspace for files by name. `pattern` is a case-insensitive ' +
    'JavaScript regular expression matched against the file name — a plain word ' +
    'works as a substring match (e.g. "Selector" finds OrderSelector.cls, ' +
    'AccountSelector.cls), or use regex syntax for more control (e.g. ' +
    '"^Account.*\\.cls$"). Returns a capped list of matching file paths (Apex ' +
    'classes/triggers, objects, fields, flows, LWC, permission sets — any ' +
    'Salesforce metadata or source file, excluding anything in .gitignore). Use ' +
    'this to discover files before reading them with read_workspace_file.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description:
          'A case-insensitive regular expression matched against the file name, e.g. "Selector" or "^Account.*\\.cls$".',
      },
    },
    required: ['pattern'],
  },
};

const READ_WORKSPACE_FILE_TOOL: ToolSpec = {
  name: 'read_workspace_file',
  description:
    'Read the full content of a single workspace file by its workspace-relative ' +
    'path (typically one returned by search_workspace_files). Use this to inspect ' +
    'code referenced in stack traces or any Salesforce metadata file you need. ' +
    'Files excluded by .gitignore cannot be read.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'The workspace-relative path to the file, e.g. "force-app/main/default/classes/OrderSelector.cls".',
      },
    },
    required: ['path'],
  },
};

const COMMON_GUIDANCE =
  'You cannot modify data. ' +
  'Before writing any SOQL query, call describe_object to verify which fields are available ' +
  '— never invent or guess field API names. If a follow-up query tool is ' +
  'provided and you genuinely need more data, you may call it. ' +
  `You have a hard budget of ${MAX_TOOL_ROUNDS} tool-call rounds for this task; spend them ` +
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
 * then drives the language model (through the injected gateway) to analyse the
 * result. The model never executes anything itself — it can only propose a
 * `run_soql` follow-up which this executor runs on its behalf.
 */
export class AiExecutor {
  constructor(
    private readonly connectionManager: ConnectionManager,
    private readonly gateway: LmGateway,
    private readonly skills: SkillsRepository,
    private readonly describeService: DescribeService,
    private readonly workspaceSearch?: WorkspaceSearch,
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
      this.throwIfAborted(signal);

      // The gather (data) step is optional — a script may be driven purely by
      // its prompt and user inputs.
      let gatheredSection = '';
      if (script.gather) {
        append('# Gathering data\n');
        const gathered = await this.runGather(script.gather);
        // Fence the raw data dump so it renders as a clean code block in the
        // Markdown preview (SOQL → pretty JSON; apex → debug-log text).
        const fenceLang = script.gather.kind === 'soql' ? 'json' : '';
        append('```' + fenceLang + '\n' + gathered + '\n```\n\n');
        gatheredSection = `\n\n## Gathered data\n${gathered}`;
      }

      const selectedSkills = this.resolveSelectedSkills(script.skills);
      const skillsSection = this.buildSkillsCatalogue(selectedSkills);
      const preamble = script.gather ? GATHER_PREAMBLE : NO_GATHER_PREAMBLE;

      const messages: ChatMessage[] = [
        {
          role: 'user',
          text: `${preamble}\n\n## Task\n${script.script}${skillsSection}${gatheredSection}`,
        },
      ];
      const tools: ToolSpec[] = [
        DESCRIBE_OBJECT_TOOL,
        ...(selectedSkills.length ? [READ_SKILL_TOOL] : []),
        ...(script.allowFollowupQueries ? [RUN_SOQL_TOOL] : []),
        ...(script.allowReadWorkspaceFiles && this.workspaceSearch
          ? [SEARCH_WORKSPACE_FILES_TOOL, READ_WORKSPACE_FILE_TOOL]
          : []),
      ];

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

  // ── Skills ──────────────────────────────────────────────────────────────

  /** The catalogue entries for the script's selected skills that still exist on disk. */
  private resolveSelectedSkills(skillIds: string[] | undefined): SkillInfo[] {
    if (!skillIds?.length) return [];
    const available = new Map(this.skills.listSkills().map((s) => [s.id, s]));
    return skillIds.map((id) => available.get(id)).filter((s): s is SkillInfo => !!s);
  }

  /** A markdown section listing the available skills, or '' when there are none. */
  private buildSkillsCatalogue(selected: SkillInfo[]): string {
    if (!selected.length) return '';
    const lines = selected.map((s) => `- ${s.id}: ${s.description || s.name}`);
    return (
      `\n\n## Available skills\n` +
      `Reusable playbooks you may consult. If one is relevant to the task, call ` +
      `read_skill with its id to read its full guidance before writing your analysis.\n` +
      lines.join('\n')
    );
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
    if (call.name === 'describe_object') {
      return this.runDescribeCall(String(call.input.objectName ?? ''), append);
    }
    if (call.name === 'run_soql') {
      return this.runSoqlCall(String(call.input.soql ?? ''), append);
    }
    if (call.name === 'read_skill') {
      return this.runReadSkillCall(String(call.input.skillId ?? ''), append);
    }
    if (call.name === 'search_workspace_files') {
      return this.runSearchWorkspaceFilesCall(String(call.input.pattern ?? ''), append);
    }
    if (call.name === 'read_workspace_file') {
      return this.runReadWorkspaceFileCall(String(call.input.path ?? ''), append);
    }
    return `Error: unknown tool "${call.name}".`;
  }

  private async runSearchWorkspaceFilesCall(
    pattern: string,
    append: (s: string) => void,
  ): Promise<string> {
    const p = pattern.trim();
    if (!p) return 'Error: no search pattern provided.';
    if (!this.workspaceSearch) return 'Error: workspace file access is not available.';
    append(`\n\n[search_workspace_files] /${p}/\n`);
    const result = await this.workspaceSearch.searchFiles(p);
    if ('error' in result) {
      append(`→ error: ${result.error}\n\n`);
      return `Error searching workspace files: ${result.error}`;
    }
    append(`→ ${result.paths.length} match(es)${result.truncated ? ' (truncated)' : ''}\n\n`);
    return JSON.stringify({ pattern: p, paths: result.paths, truncated: result.truncated });
  }

  private async runReadWorkspaceFileCall(
    filePath: string,
    append: (s: string) => void,
  ): Promise<string> {
    const rel = filePath.trim();
    if (!rel) return 'Error: no file path provided.';
    if (!this.workspaceSearch) return 'Error: workspace file access is not available.';
    append(`\n\n[read_workspace_file] ${rel}\n`);
    const result = await this.workspaceSearch.readFile(rel);
    if ('error' in result) {
      append(`→ error: ${result.error}\n\n`);
      return `Error reading workspace file: ${result.error}`;
    }
    append(`→ ${result.content.length} char(s) from ${result.path}\n\n`);
    return JSON.stringify({ path: result.path, content: result.content });
  }

  private runReadSkillCall(skillId: string, append: (s: string) => void): string {
    const id = skillId.trim();
    if (!id) return 'Error: no skill id provided.';
    append(`\n\n[read_skill] ${id}\n`);
    const body = this.skills.readSkill(id);
    if (body === null) {
      append(`→ error: unknown skill\n\n`);
      return `Error: unknown skill "${id}".`;
    }
    append(`→ ${body.length} char(s)\n\n`);
    return body;
  }

  private async runDescribeCall(objectName: string, append: (s: string) => void): Promise<string> {
    const name = objectName.trim();
    if (!name) return 'Error: no object name provided.';
    append(`\n\n[describe_object] ${name}\n`);
    try {
      const describe = await this.describeService.describeSObject(name);
      const fields = describe.fields.map((f) => {
        const proj: { name: string; label: string; type: string; referenceTo?: string[] } = {
          name: f.name,
          label: f.label,
          type: f.type,
        };
        if (f.referenceTo.length) proj.referenceTo = f.referenceTo;
        return proj;
      });
      append(`→ ${fields.length} field(s)\n\n`);
      return JSON.stringify({ objectName: describe.name, fields }, null, 2);
    } catch (err) {
      const msg = (err as Error).message;
      append(`→ error: ${msg}\n\n`);
      return `Error describing object: ${msg}`;
    }
  }

  private async runSoqlCall(soql: string, append: (s: string) => void): Promise<string> {
    const query = soql.trim();
    if (!query) return 'Error: no SOQL query provided.';
    // Defense in depth: ConnectionManager.query only runs SOQL, but reject
    // anything that does not look like a SELECT so the model cannot be coaxed
    // into a non-query payload.
    if (!/^select\b/i.test(query)) {
      return 'Error: only SELECT/SOQL queries are allowed.';
    }
    append(`\n\n[run_soql] ${query}\n`);
    try {
      const result = await this.connectionManager.query(query);
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

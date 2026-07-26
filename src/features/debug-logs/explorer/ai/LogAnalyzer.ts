// Drives the language model over one debug log: build the digest, offer the log
// (and optionally workspace/org) tools, stream the analysis back. vscode-free —
// the gateway, describe service and workspace search are injected, exactly like
// the yaml-scripts AiExecutor.
import type { ConnectionManager } from '../../../../salesforce/connection';
import type { DescribeService } from '../../../../services/describe/DescribeService';
import { AiConversation, type ModelFallback } from '../../../../services/ai/AiConversation';
import {
  createDescribeObjectTool,
  createRunSoqlTool,
} from '../../../../services/ai/tools/orgTools';
import type { ToolHandler } from '../../../../services/ai/tools/ToolHandler';
import {
  createReadWorkspaceFileTool,
  createSearchWorkspaceFilesTool,
} from '../../../../services/ai/tools/workspaceTools';
import type { ChatMessage, LmGateway, WorkspaceSearch } from '../../../../services/ai/types';
import type { OpenedLog } from '../DebugLogsService';
import type { ApexLogRow } from '../types';
import { buildLogDigest } from './logDigest';
import { createExecutionTreeTool, createReadLogLinesTool, createSearchLogTool } from './logTools';
import { buildAnalysisPreamble } from './prompt';

export interface AnalyzeLogRequest {
  opened: OpenedLog;
  row: ApexLogRow | null;
  /** Extra instruction typed by the user, e.g. "focus on the callout". */
  question?: string;
  modelId?: string;
  allowWorkspaceFiles: boolean;
  allowOrgQueries: boolean;
}

export interface AnalyzeLogResult {
  analysis: string;
  cancelled?: boolean;
  modelFallback?: ModelFallback;
}

export class LogAnalyzer {
  private readonly conversation: AiConversation;

  constructor(
    gateway: LmGateway,
    private readonly connectionManager: ConnectionManager,
    private readonly describeService: DescribeService,
    private readonly workspaceSearch?: WorkspaceSearch,
  ) {
    this.conversation = new AiConversation(gateway);
  }

  async analyze(
    req: AnalyzeLogRequest,
    signal?: AbortSignal,
    onChunk?: (chunk: string) => void,
    onModelFallback?: (fallback: ModelFallback) => void,
  ): Promise<AnalyzeLogResult> {
    let analysis = '';
    const append = (s: string) => {
      analysis += s;
      onChunk?.(s);
    };

    const useWorkspace = req.allowWorkspaceFiles && !!this.workspaceSearch;
    const tools: ToolHandler[] = [
      createSearchLogTool(req.opened.parsed.events),
      createReadLogLinesTool(req.opened.parsed.events),
      createExecutionTreeTool(req.opened.parsed.tree),
      ...(useWorkspace && this.workspaceSearch
        ? [
            createSearchWorkspaceFilesTool(this.workspaceSearch),
            createReadWorkspaceFileTool(this.workspaceSearch),
          ]
        : []),
      ...(req.allowOrgQueries
        ? [
            createDescribeObjectTool(this.describeService),
            createRunSoqlTool(this.connectionManager),
          ]
        : []),
    ];

    const digest = buildLogDigest({
      row: req.row,
      parsed: req.opened.parsed,
      totalLines: req.opened.totalLines,
    });
    const question = req.question?.trim()
      ? `\n\n## The user specifically asks\n${req.question.trim()}`
      : '';
    const partialNote = req.opened.partial
      ? '\n\n_Note: this log was too large to hold in full; only its first and last sections are ' +
        'searchable through the log tools._'
      : '';

    const messages: ChatMessage[] = [
      {
        role: 'user',
        text:
          buildAnalysisPreamble({
            hasWorkspaceTools: useWorkspace,
            hasOrgTools: req.allowOrgQueries,
          }) + `\n\n# Debug log briefing\n${digest}${partialNote}${question}`,
      },
    ];

    try {
      const { fallback } = await this.conversation.run({
        modelId: req.modelId || undefined,
        messages,
        tools,
        append,
        signal,
        onModelFallback,
      });
      return { analysis, ...(fallback ? { modelFallback: fallback } : {}) };
    } catch (err) {
      const message = (err as Error).message;
      if (message === 'Operation cancelled') return { analysis, cancelled: true };
      throw err;
    }
  }
}

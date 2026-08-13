// Drives the Overview tab's ad-hoc "Ask the AI" card. The multi-turn thread
// itself lives in the shared ChatSession (src/services/ai/ChatSession.ts);
// what stays here is the part that is genuinely Ask-the-AI-specific: mapping
// the two user-facing access toggles onto a tool set, and locking that set for
// the life of the conversation. vscode-free: gateway, ConnectionManager,
// DescribeService, SkillsRepository and WorkspaceSearch are all injected.
import type { ConnectionManager } from '../../../salesforce/connection';
import type { DescribeService } from '../../../services/describe/DescribeService';
import type { ModelFallback } from '../../../services/ai/AiConversation';
import { ChatSession } from '../../../services/ai/ChatSession';
import {
  createCurrentUserTool,
  createDescribeObjectTool,
  createRunSoqlTool,
} from '../../../services/ai/tools/orgTools';
import { createReadSkillTool, buildSkillsCatalogue } from '../../../services/ai/tools/skillTools';
import type { ToolHandler } from '../../../services/ai/tools/ToolHandler';
import {
  createReadWorkspaceFileTool,
  createSearchWorkspaceFilesTool,
} from '../../../services/ai/tools/workspaceTools';
import type { ChatMessage, LmGateway, WorkspaceSearch } from '../../../services/ai/types';
import type { SkillsRepository } from '../../../services/skills/SkillsRepository';
import { buildAskAiPreamble } from './prompt';
import type { AskAiAccess, LockedAccess } from './types';

export type { AskAiAccess, LockedAccess };

export interface AskAiRequest {
  question: string;
  modelId?: string;
  /** Only honoured on the first turn of a conversation — see the class docs. */
  access: AskAiAccess;
}

export interface AskAiResult {
  answer: string;
  /** 0-based index of the turn that just completed. */
  turnIndex: number;
  /** The EFFECTIVE (locked) access for this conversation — may differ from the request on turn 2+. */
  access: AskAiAccess;
  cancelled?: boolean;
  modelFallback?: ModelFallback;
}

export class AskAiService {
  private readonly session: ChatSession;
  /**
   * The tool set is fixed the moment the first turn lands. History keeps
   * `toolResult` turns for every tool call the model made; if the declared
   * tool set changed mid-thread (e.g. "Query the org" unticked after a turn
   * that ran run_soql), a later turn would carry a toolResult for an
   * undeclared tool and the language model API would reject or misbehave.
   * Locking after the first successful turn keeps the declaration stable for
   * the life of the conversation. `reset()` clears it for a fresh thread.
   */
  private locked: LockedAccess | null = null;

  constructor(
    gateway: LmGateway,
    private readonly connectionManager: ConnectionManager,
    private readonly describeService: DescribeService,
    private readonly skills: SkillsRepository,
    private readonly workspaceSearch?: WorkspaceSearch,
  ) {
    this.session = new ChatSession(gateway);
  }

  get turnCount(): number {
    return this.session.turnCount;
  }

  /** Start a brand-new conversation: clears history and unlocks the tool set. */
  reset(): void {
    this.session.reset();
    this.locked = null;
  }

  /**
   * Everything needed to archive the live conversation, or `null` when there's
   * nothing to archive yet (no turn has landed). Callers that persist this must
   * deep-clone `messages` first — `AiConversation` mutates it in place, and this
   * returns the live array reference, not a copy.
   */
  getSnapshot(): {
    messages: ChatMessage[];
    locked: LockedAccess | null;
    turns: number;
    modelId: string;
  } | null {
    const snapshot = this.session.getSnapshot();
    if (!snapshot) return null;
    return { ...snapshot, locked: this.locked };
  }

  /** Resume a previously archived conversation with its tool-access lock intact. */
  restoreSnapshot(snapshot: {
    messages: ChatMessage[];
    locked: LockedAccess | null;
    turns: number;
    modelId: string;
  }): void {
    this.session.restoreSnapshot({
      messages: snapshot.messages,
      turns: snapshot.turns,
      modelId: snapshot.modelId,
    });
    this.locked = snapshot.locked;
  }

  async ask(
    req: AskAiRequest,
    signal?: AbortSignal,
    onChunk?: (chunk: string) => void,
    onModelFallback?: (fallback: ModelFallback) => void,
  ): Promise<AskAiResult> {
    const locked: LockedAccess = this.locked ?? {
      allowWorkspaceFiles: req.access.allowWorkspaceFiles && !!this.workspaceSearch,
      allowOrgQueries: req.access.allowOrgQueries,
      // Snapshotting here (not re-checked per turn) keeps the declared tool
      // set stable even if a skill is added or removed mid-conversation.
      hasSkills: this.skills.listSkills().length > 0,
    };

    const result = await this.session.ask(
      {
        question: req.question,
        modelId: req.modelId,
        tools: this.buildTools(locked),
        firstMessagePrefix:
          `${buildAskAiPreamble({
            hasWorkspaceTools: locked.allowWorkspaceFiles,
            hasOrgTools: locked.allowOrgQueries,
          })}${locked.hasSkills ? buildSkillsCatalogue(this.skills.listSkills()) : ''}` +
          `\n\n## Question\n`,
      },
      signal,
      onChunk,
      onModelFallback,
    );

    // Only lock in once a turn has actually landed successfully — a cancelled
    // turn was rolled back, so the next one is free to declare a different set.
    if (!result.cancelled) this.locked = locked;

    return {
      ...result,
      access: {
        allowWorkspaceFiles: locked.allowWorkspaceFiles,
        allowOrgQueries: locked.allowOrgQueries,
      },
    };
  }

  private buildTools(locked: LockedAccess): ToolHandler[] {
    return [
      ...(locked.allowOrgQueries
        ? [
            createDescribeObjectTool(this.describeService),
            createRunSoqlTool(this.connectionManager),
            createCurrentUserTool(this.connectionManager),
          ]
        : []),
      ...(locked.allowWorkspaceFiles && this.workspaceSearch
        ? [
            createSearchWorkspaceFilesTool(this.workspaceSearch),
            createReadWorkspaceFileTool(this.workspaceSearch),
          ]
        : []),
      ...(locked.hasSkills ? [createReadSkillTool(this.skills)] : []),
    ];
  }
}

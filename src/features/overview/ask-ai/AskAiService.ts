// Drives an ad-hoc, multi-turn conversation with the language model for the
// Overview tab's "Ask the AI" card. Unlike yaml-scripts' AiExecutor (one fixed
// gather + one analysis pass) or the Debug Logs LogAnalyzer (one question per
// log), this keeps the same ChatMessage[] alive across calls to ask() so
// follow-up questions reuse prior context and tool results — that continuity
// is the whole point of a chat box. vscode-free: gateway, ConnectionManager,
// DescribeService, SkillsRepository and WorkspaceSearch are all injected.
import type { ConnectionManager } from '../../../salesforce/connection';
import type { DescribeService } from '../../../services/describe/DescribeService';
import { AiConversation, type ModelFallback } from '../../../services/ai/AiConversation';
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
  private readonly conversation: AiConversation;
  private messages: ChatMessage[] = [];
  private turns = 0;
  private running = false;
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
  /** The modelId actually used on the most recent successful turn — needed to
   *  resume a restored conversation with the same model it was started with. */
  private lastModelId = '';

  constructor(
    gateway: LmGateway,
    private readonly connectionManager: ConnectionManager,
    private readonly describeService: DescribeService,
    private readonly skills: SkillsRepository,
    private readonly workspaceSearch?: WorkspaceSearch,
  ) {
    this.conversation = new AiConversation(gateway);
  }

  get isRunning(): boolean {
    return this.running;
  }

  get turnCount(): number {
    return this.turns;
  }

  /** Start a brand-new conversation: clears history and unlocks the tool set. */
  reset(): void {
    this.messages = [];
    this.turns = 0;
    this.locked = null;
    this.lastModelId = '';
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
    if (this.turns === 0) return null;
    return {
      messages: this.messages,
      locked: this.locked,
      turns: this.turns,
      modelId: this.lastModelId,
    };
  }

  /** Resume a previously archived conversation with its tool-access lock intact. */
  restoreSnapshot(snapshot: {
    messages: ChatMessage[];
    locked: LockedAccess | null;
    turns: number;
    modelId: string;
  }): void {
    if (this.running) {
      throw new Error('Cannot restore a conversation while one is running.');
    }
    this.messages = snapshot.messages;
    this.locked = snapshot.locked;
    this.turns = snapshot.turns;
    this.lastModelId = snapshot.modelId;
  }

  async ask(
    req: AskAiRequest,
    signal?: AbortSignal,
    onChunk?: (chunk: string) => void,
    onModelFallback?: (fallback: ModelFallback) => void,
  ): Promise<AskAiResult> {
    if (this.running) {
      throw new Error('Another question is still running.');
    }

    const locked: LockedAccess = this.locked ?? {
      allowWorkspaceFiles: req.access.allowWorkspaceFiles && !!this.workspaceSearch,
      allowOrgQueries: req.access.allowOrgQueries,
      // Snapshotting here (not re-checked per turn) keeps the declared tool
      // set stable even if a skill is added or removed mid-conversation.
      hasSkills: this.skills.listSkills().length > 0,
    };

    // Snapshot BEFORE mutating so a cancel/error can roll the whole turn back
    // (see the catch block below) — AiConversation mutates `this.messages` in
    // place as it runs, so a truncated run must not leave a dangling
    // assistant turn with unanswered tool calls behind for the next ask().
    const committed = this.messages.length;
    const isFirst = committed === 0;

    this.messages.push({
      role: 'user',
      text: isFirst
        ? `${buildAskAiPreamble({
            hasWorkspaceTools: locked.allowWorkspaceFiles,
            hasOrgTools: locked.allowOrgQueries,
          })}${locked.hasSkills ? buildSkillsCatalogue(this.skills.listSkills()) : ''}` +
          `\n\n## Question\n${req.question}`
        : req.question,
    });

    let answer = '';
    const append = (s: string) => {
      answer += s;
      onChunk?.(s);
    };

    this.running = true;
    try {
      const { fallback } = await this.conversation.run({
        modelId: req.modelId || undefined,
        messages: this.messages,
        tools: this.buildTools(locked),
        append,
        signal,
        onModelFallback,
      });
      // Only lock in once a turn has actually landed successfully.
      this.locked = locked;
      this.lastModelId = req.modelId || this.lastModelId;
      const turnIndex = this.turns++;
      return {
        answer,
        turnIndex,
        access: {
          allowWorkspaceFiles: locked.allowWorkspaceFiles,
          allowOrgQueries: locked.allowOrgQueries,
        },
        ...(fallback ? { modelFallback: fallback } : {}),
      };
    } catch (err) {
      // Roll the whole turn back — including the user message just pushed —
      // so a retry re-asks cleanly and a cancelled first turn still sends the
      // preamble again next time (isFirst is derived from length, never cached).
      this.messages.length = committed;
      const message = (err as Error).message;
      if (message === 'Operation cancelled') {
        return {
          answer,
          turnIndex: this.turns,
          access: {
            allowWorkspaceFiles: locked.allowWorkspaceFiles,
            allowOrgQueries: locked.allowOrgQueries,
          },
          cancelled: true,
        };
      }
      throw err;
    } finally {
      this.running = false;
    }
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

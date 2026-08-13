// A multi-turn conversation with the language model: keeps one ChatMessage[]
// alive across calls to ask(), so follow-up questions reuse prior context and
// tool results. Extracted from the Overview tab's AskAiService so the SOQL
// tab's query generator could reuse it without one feature importing from
// another feature's folder.
//
// Deliberately policy-free: it takes an already-resolved tool list and an
// already-built preamble. Whether that tool list may change between turns is
// the caller's problem — AskAiService locks its own after the first successful
// turn (its toggles are user-facing); the SOQL panel's set is fixed, so it
// needs no locking at all.
import { AiConversation, type ModelFallback } from './AiConversation';
import type { ToolHandler } from './tools/ToolHandler';
import type { ChatMessage, LmGateway } from './types';

export interface ChatSessionRequest {
  question: string;
  modelId?: string;
  /** The tools the model may call this turn, already resolved by the caller. */
  tools: ToolHandler[];
  /**
   * Prepended to the question on the FIRST turn only — the preamble, plus
   * anything else that belongs once per conversation (a skills catalogue, a
   * question header). There is no system role in LmGateway, so this is how a
   * system prompt is delivered.
   */
  firstMessagePrefix?: string;
}

export interface ChatSessionResult {
  answer: string;
  /** 0-based index of the turn that just completed. */
  turnIndex: number;
  cancelled?: boolean;
  modelFallback?: ModelFallback;
}

/** Everything needed to archive or resume a thread. */
export interface ChatSessionSnapshot {
  messages: ChatMessage[];
  turns: number;
  modelId: string;
}

export class ChatSession {
  private readonly conversation: AiConversation;
  private messages: ChatMessage[] = [];
  private turns = 0;
  private running = false;
  /** The modelId actually used on the most recent successful turn — needed to
   *  resume a restored conversation with the model it was started with. */
  private lastModelId = '';

  constructor(gateway: LmGateway) {
    this.conversation = new AiConversation(gateway);
  }

  get turnCount(): number {
    return this.turns;
  }

  /** Start a brand-new conversation: clears history and the remembered model. */
  reset(): void {
    this.messages = [];
    this.turns = 0;
    this.lastModelId = '';
  }

  /**
   * The live thread, or `null` when nothing has landed yet. Callers that
   * persist this must deep-clone `messages` first — `AiConversation` mutates it
   * in place, and this returns the live array reference, not a copy.
   */
  getSnapshot(): ChatSessionSnapshot | null {
    if (this.turns === 0) return null;
    return { messages: this.messages, turns: this.turns, modelId: this.lastModelId };
  }

  /** Resume a previously archived thread. */
  restoreSnapshot(snapshot: ChatSessionSnapshot): void {
    if (this.running) {
      throw new Error('Cannot restore a conversation while one is running.');
    }
    this.messages = snapshot.messages;
    this.turns = snapshot.turns;
    this.lastModelId = snapshot.modelId;
  }

  async ask(
    req: ChatSessionRequest,
    signal?: AbortSignal,
    onChunk?: (chunk: string) => void,
    onModelFallback?: (fallback: ModelFallback) => void,
  ): Promise<ChatSessionResult> {
    if (this.running) {
      throw new Error('Another question is still running.');
    }

    // Snapshot BEFORE mutating so a cancel/error can roll the whole turn back
    // (see the catch block below) — AiConversation mutates `this.messages` in
    // place as it runs, and it pushes the assistant turn BEFORE running the
    // tools it proposed. A run truncated in between would otherwise leave a
    // dangling assistant turn whose toolCalls have no matching toolResult,
    // which the language model API rejects on the next turn.
    const committed = this.messages.length;
    const isFirst = committed === 0;

    this.messages.push({
      role: 'user',
      text:
        isFirst && req.firstMessagePrefix ? req.firstMessagePrefix + req.question : req.question,
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
        tools: req.tools,
        append,
        signal,
        onModelFallback,
      });
      this.lastModelId = req.modelId || this.lastModelId;
      const turnIndex = this.turns++;
      return { answer, turnIndex, ...(fallback ? { modelFallback: fallback } : {}) };
    } catch (err) {
      // Roll the whole turn back — including the user message just pushed — so
      // a retry re-asks cleanly and a cancelled FIRST turn still sends the
      // preamble again next time (isFirst is derived from length, never cached).
      this.messages.length = committed;
      if ((err as Error).message === 'Operation cancelled') {
        return { answer, turnIndex: this.turns, cancelled: true };
      }
      throw err;
    } finally {
      this.running = false;
    }
  }
}

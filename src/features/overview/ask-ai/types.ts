// Shared types for the Overview tab's "Ask the AI" chat and its history store.
import type { ChatMessage } from '../../../services/ai/types';

export interface AskAiAccess {
  allowWorkspaceFiles: boolean;
  allowOrgQueries: boolean;
}

/** The tool set actually locked in for a conversation — see AskAiService's class docs. */
export interface LockedAccess extends AskAiAccess {
  hasSkills: boolean;
}

/** Lightweight entry for the History ▾ dropdown — never carries the raw thread. */
export interface AskAiConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
}

/**
 * A conversation as persisted by AskAiHistoryStore. Saved after every
 * completed reply (see index.ts's saveCurrentConversation) — `id` is stable
 * for the life of a session, so a multi-turn conversation upserts the same
 * record rather than accumulating one per question.
 */
export interface AskAiConversation extends AskAiConversationSummary {
  modelId: string;
  /** Display markdown, reconstructed host-side from `messages` — see reconstructTranscript.ts. */
  transcript: string;
  /** The raw thread, empty + messagesTruncated when it exceeded the store's size cap. */
  messages: ChatMessage[];
  messagesTruncated: boolean;
  locked: LockedAccess | null;
  turns: number;
}

import * as fs from 'fs';
import * as path from 'path';
import type { AskAiConversation, AskAiConversationSummary } from './types';

/** Oldest conversations are evicted once the list exceeds this many entries. */
export const HISTORY_CAP = 30;

/**
 * Above this serialized size, the raw `ChatMessage[]` thread is dropped from the
 * persisted record (`messagesTruncated: true`) — the transcript/title/model are
 * always kept in full; only the ability to CONTINUE the conversation is lost.
 * 2 MB, well under DebugLogsService's existing 5 MB inline-body precedent.
 */
export const MAX_MESSAGES_BYTES = 2 * 1024 * 1024;

const INDEX_FILE = 'index.json';

/**
 * Persistent, workspace-scoped, cross-org history of "Ask the AI" conversations.
 * Disk-backed rather than workspaceState — a conversation's raw tool-result
 * payloads (full SOQL result sets, full file contents) are uncapped, and
 * workspaceState rewrites its entire value on every update, which would mean
 * every save/delete serializes a multi-tens-of-MB blob in memory. Mirrors
 * DescribeDiskCache: vscode-free, gitignored via a self-writing `.gitignore: *`,
 * best-effort I/O — history must never break a chat.
 *
 * Layout: a single `index.json` (array of lightweight summaries) is the fast
 * path for `list()` — it never touches the heavier per-conversation files —
 * plus one `conversation-<id>.json` per full record, read only by `get(id)`.
 * `save()` is called after every completed reply, not just at session end —
 * see its own doc comment for the upsert semantics that makes that safe.
 */
export class AskAiHistoryStore {
  constructor(private readonly dir: string) {}

  list(): AskAiConversationSummary[] {
    try {
      const raw = fs.readFileSync(path.join(this.dir, INDEX_FILE), 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  get(id: string): AskAiConversation | null {
    try {
      const raw = fs.readFileSync(this.conversationFile(id), 'utf8');
      return JSON.parse(raw) as AskAiConversation;
    } catch {
      return null;
    }
  }

  /**
   * Upserts by `conversation.id` — a saved conversation is called with the
   * SAME id on every subsequent turn (see index.ts's saveCurrentConversation),
   * so a re-save replaces the existing entry (moved to the front) instead of
   * accumulating a duplicate row per question.
   */
  save(conversation: AskAiConversation): void {
    try {
      this.ensureDir();
      const stored = this.enforceSizeCap(conversation);

      const index = this.list().filter((entry) => entry.id !== stored.id);
      index.unshift({ id: stored.id, title: stored.title, updatedAt: stored.updatedAt });
      const evicted = index.slice(HISTORY_CAP);
      const kept = index.slice(0, HISTORY_CAP);

      fs.writeFileSync(this.conversationFile(stored.id), JSON.stringify(stored), 'utf8');
      fs.writeFileSync(path.join(this.dir, INDEX_FILE), JSON.stringify(kept), 'utf8');
      for (const entry of evicted) {
        this.removeFile(entry.id);
      }
    } catch {
      // best-effort — a failed save must never break the conversation itself
    }
  }

  remove(id: string): void {
    try {
      const kept = this.list().filter((entry) => entry.id !== id);
      fs.writeFileSync(path.join(this.dir, INDEX_FILE), JSON.stringify(kept), 'utf8');
      this.removeFile(id);
    } catch {
      // best-effort
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private enforceSizeCap(conversation: AskAiConversation): AskAiConversation {
    if (conversation.messagesTruncated) return conversation;
    const size = Buffer.byteLength(JSON.stringify(conversation.messages), 'utf8');
    if (size <= MAX_MESSAGES_BYTES) return conversation;
    return { ...conversation, messages: [], messagesTruncated: true };
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
    const gitignore = path.join(this.dir, '.gitignore');
    if (!fs.existsSync(gitignore)) {
      fs.writeFileSync(gitignore, '*\n', 'utf8');
    }
  }

  private removeFile(id: string): void {
    try {
      fs.rmSync(this.conversationFile(id), { force: true });
    } catch {
      // best-effort
    }
  }

  private conversationFile(id: string): string {
    return path.join(this.dir, `conversation-${this.safe(id)}.json`);
  }

  /** Filesystem-safe token: non-alphanumerics (besides -/_) → `_`. */
  private safe(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]/g, '_');
  }
}

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AskAiHistoryStore, HISTORY_CAP, MAX_MESSAGES_BYTES } from './AskAiHistoryStore';
import type { AskAiConversation } from './types';

function makeConversation(overrides: Partial<AskAiConversation> = {}): AskAiConversation {
  return {
    id: 'c1',
    title: 'How many accounts?',
    updatedAt: Date.now(),
    modelId: 'gpt-4o',
    transcript: '## You\nHow many accounts?\n\n## Assistant\n42',
    messages: [
      { role: 'user', text: 'How many accounts?' },
      { role: 'assistant', text: '42' },
    ],
    messagesTruncated: false,
    locked: { allowWorkspaceFiles: true, allowOrgQueries: true, hasSkills: false },
    turns: 1,
    ...overrides,
  };
}

describe('AskAiHistoryStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-ai-history-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a saved conversation', () => {
    const store = new AskAiHistoryStore(dir);
    const conversation = makeConversation();
    store.save(conversation);
    expect(store.get('c1')).toEqual(conversation);
  });

  it('list() returns lightweight summaries in most-recent-first order', () => {
    const store = new AskAiHistoryStore(dir);
    store.save(makeConversation({ id: 'c1', title: 'first', updatedAt: 1 }));
    store.save(makeConversation({ id: 'c2', title: 'second', updatedAt: 2 }));
    expect(store.list()).toEqual([
      { id: 'c2', title: 'second', updatedAt: 2 },
      { id: 'c1', title: 'first', updatedAt: 1 },
    ]);
  });

  it('save() with an existing id updates that entry in place instead of duplicating it', () => {
    const store = new AskAiHistoryStore(dir);
    store.save(makeConversation({ id: 'c1', title: 'first question', updatedAt: 1, turns: 1 }));
    store.save(
      makeConversation({
        id: 'c1',
        title: 'first question', // title stays derived from turn 0 regardless of follow-ups
        updatedAt: 2,
        turns: 2,
        messages: [
          { role: 'user', text: 'first question' },
          { role: 'assistant', text: 'answer 1' },
          { role: 'user', text: 'follow-up' },
          { role: 'assistant', text: 'answer 2' },
        ],
      }),
    );

    // Still exactly one entry — not two — and it's the updated version.
    expect(store.list()).toEqual([{ id: 'c1', title: 'first question', updatedAt: 2 }]);
    expect(store.get('c1')?.turns).toBe(2);
    expect(store.get('c1')?.messages).toHaveLength(4);
  });

  it('re-saving an older entry moves it back to the front of the list', () => {
    const store = new AskAiHistoryStore(dir);
    store.save(makeConversation({ id: 'c1', updatedAt: 1 }));
    store.save(makeConversation({ id: 'c2', updatedAt: 2 }));
    // A follow-up question lands on the older conversation (c1).
    store.save(makeConversation({ id: 'c1', updatedAt: 3, turns: 2 }));

    expect(store.list().map((entry) => entry.id)).toEqual(['c1', 'c2']);
  });

  it('get() returns null on a miss', () => {
    const store = new AskAiHistoryStore(dir);
    expect(store.get('nope')).toBeNull();
  });

  it('remove() deletes both the index entry and the conversation file', () => {
    const store = new AskAiHistoryStore(dir);
    store.save(makeConversation({ id: 'c1' }));
    store.remove('c1');
    expect(store.get('c1')).toBeNull();
    expect(store.list()).toEqual([]);
  });

  it('caps the list at HISTORY_CAP, evicting the oldest', () => {
    const store = new AskAiHistoryStore(dir);
    for (let i = 0; i < HISTORY_CAP + 1; i++) {
      store.save(makeConversation({ id: `c${i}`, title: `conv ${i}`, updatedAt: i }));
    }
    const list = store.list();
    expect(list).toHaveLength(HISTORY_CAP);
    // The very first save (c0) should have been evicted — it's the oldest.
    expect(list.some((entry) => entry.id === 'c0')).toBe(false);
    expect(store.get('c0')).toBeNull();
    // The most recent save is still there and at the front.
    expect(list[0].id).toBe(`c${HISTORY_CAP}`);
  });

  it('truncates oversized raw message threads but keeps the transcript/title intact', () => {
    const store = new AskAiHistoryStore(dir);
    const bigText = 'x'.repeat(MAX_MESSAGES_BYTES + 1);
    store.save(
      makeConversation({
        id: 'big',
        messages: [{ role: 'user', text: bigText }],
      }),
    );
    const stored = store.get('big');
    expect(stored?.messagesTruncated).toBe(true);
    expect(stored?.messages).toEqual([]);
    expect(stored?.transcript).toBe('## You\nHow many accounts?\n\n## Assistant\n42');
    expect(stored?.title).toBe('How many accounts?');
  });

  it('list() returns [] when the index is missing', () => {
    const store = new AskAiHistoryStore(dir);
    expect(store.list()).toEqual([]);
  });

  it('list() returns [] (no throw) on corrupt index JSON', () => {
    const store = new AskAiHistoryStore(dir);
    store.save(makeConversation());
    fs.writeFileSync(path.join(dir, 'index.json'), 'not json {', 'utf8');
    expect(store.list()).toEqual([]);
  });

  it('get() returns null (no throw) on a corrupt conversation file', () => {
    const store = new AskAiHistoryStore(dir);
    store.save(makeConversation({ id: 'c1' }));
    fs.writeFileSync(path.join(dir, 'conversation-c1.json'), 'not json {', 'utf8');
    expect(store.get('c1')).toBeNull();
  });

  it('writes a self-ignoring .gitignore on first save', () => {
    const store = new AskAiHistoryStore(dir);
    store.save(makeConversation());
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe('*\n');
  });
});

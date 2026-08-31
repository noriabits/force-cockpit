import { describe, expect, it } from 'vitest';
import { createAskAiStateStore, DEFAULT_STATE } from './AskAiStateStore';

function makeMemento() {
  const store = new Map<string, unknown>();
  return {
    get: <T>(key: string, defaultValue: T): T => (store.get(key) as T) ?? defaultValue,
    update: async (key: string, value: unknown) => {
      store.set(key, value);
    },
  };
}

describe('createAskAiStateStore', () => {
  it('starts from the defaults — auto model, both tools on', () => {
    const state = createAskAiStateStore(makeMemento()).getState();
    expect(state).toEqual(DEFAULT_STATE);
    expect(state.modelId).toBe('');
    expect(state.allowWorkspaceFiles).toBe(true);
    expect(state.allowOrgQueries).toBe(true);
  });

  it('merges a partial patch and persists it', async () => {
    const memento = makeMemento();
    const store = createAskAiStateStore(memento);
    await store.save({ allowOrgQueries: false });
    const state = createAskAiStateStore(memento).getState();
    expect(state.allowOrgQueries).toBe(false);
    // Untouched keys keep their defaults.
    expect(state.allowWorkspaceFiles).toBe(true);
  });

  it('fills in keys added after the state was first written', () => {
    const memento = makeMemento();
    void memento.update('askAi.state', { modelId: 'gpt-4o' });
    const state = createAskAiStateStore(memento).getState();
    expect(state.modelId).toBe('gpt-4o');
    expect(state.allowWorkspaceFiles).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { DebugLogsStateStore, DEFAULT_STATE } from './DebugLogsStateStore';

function makeMemento() {
  const store = new Map<string, unknown>();
  return {
    get: <T>(key: string, defaultValue: T): T => (store.get(key) as T) ?? defaultValue,
    update: async (key: string, value: unknown) => {
      store.set(key, value);
    },
  };
}

describe('DebugLogsStateStore', () => {
  it('starts from the defaults, with Balanced preselected', () => {
    const state = new DebugLogsStateStore(makeMemento()).getState();
    expect(state).toEqual(DEFAULT_STATE);
    expect(state.presetId).toBe('balanced');
    expect(state.hideEmptyLogs).toBe(false);
  });

  it('merges a partial patch and persists it', async () => {
    const memento = makeMemento();
    const store = new DebugLogsStateStore(memento);
    await store.save({ hideEmptyLogs: true, durationMs: 3600_000 });
    const state = new DebugLogsStateStore(memento).getState();
    expect(state.hideEmptyLogs).toBe(true);
    expect(state.durationMs).toBe(3600_000);
    // Untouched keys keep their defaults.
    expect(state.presetId).toBe('balanced');
  });

  it('fills in keys added after the state was first written', () => {
    const memento = makeMemento();
    void memento.update('debugLogs.state', { presetId: 'deep-trace' });
    const state = new DebugLogsStateStore(memento).getState();
    expect(state.presetId).toBe('deep-trace');
    expect(state.allowWorkspaceFiles).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import type { Memento } from 'vscode';
import { RestCallStateStore } from './RestCallStateStore';

function makeMemento(initial: Record<string, unknown> = {}): Memento {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    get: <T>(key: string, def?: T) => (store.has(key) ? store.get(key) : def) as T,
    update: async (key: string, value: unknown) => {
      store.set(key, value);
    },
    keys: () => Array.from(store.keys()),
  } as Memento;
}

describe('RestCallStateStore', () => {
  it('returns the default config when nothing is stored', () => {
    const state = new RestCallStateStore(makeMemento()).getState();
    expect(state).toEqual({ method: 'POST', endpoint: '', body: '' });
  });

  it('merges stored fields over the defaults', () => {
    const store = new RestCallStateStore(
      makeMemento({ 'restCall.lastConfig': { method: 'GET', endpoint: '/x' } }),
    );
    expect(store.getState()).toEqual({ method: 'GET', endpoint: '/x', body: '' });
  });

  it('round-trips a saved config', async () => {
    const memento = makeMemento();
    const store = new RestCallStateStore(memento);
    await store.save({ method: 'PATCH', endpoint: '/services/apexrest/x', body: '{"a":1}' });
    expect(store.getState()).toEqual({
      method: 'PATCH',
      endpoint: '/services/apexrest/x',
      body: '{"a":1}',
    });
  });
});

import { describe, expect, it, beforeEach } from 'vitest';
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
  describe('getState', () => {
    it('returns the default config when nothing is stored', () => {
      const state = new RestCallStateStore(makeMemento()).getState();
      expect(state).toEqual({
        method: 'POST',
        endpoint: '',
        body: '',
        headers: [],
        history: [],
        savedRequests: [],
      });
    });

    it('merges stored fields over the defaults', () => {
      const store = new RestCallStateStore(
        makeMemento({ 'restCall.lastConfig': { method: 'GET', endpoint: '/x' } }),
      );
      expect(store.getState()).toEqual({
        method: 'GET',
        endpoint: '/x',
        body: '',
        headers: [],
        history: [],
        savedRequests: [],
      });
    });
  });

  describe('save', () => {
    it('round-trips a saved config including headers', async () => {
      const memento = makeMemento();
      const store = new RestCallStateStore(memento);
      await store.save({
        method: 'PATCH',
        endpoint: '/services/apexrest/x',
        body: '{"a":1}',
        headers: [{ key: 'X-Foo', value: 'bar' }],
      });
      const state = store.getState();
      expect(state.method).toBe('PATCH');
      expect(state.endpoint).toBe('/services/apexrest/x');
      expect(state.body).toBe('{"a":1}');
      expect(state.headers).toEqual([{ key: 'X-Foo', value: 'bar' }]);
    });
  });

  describe('addHistory', () => {
    let store: RestCallStateStore;
    beforeEach(() => {
      store = new RestCallStateStore(makeMemento());
    });

    it('prepends new entries newest-first', async () => {
      await store.addHistory({ method: 'GET', endpoint: '/a', body: '', headers: [] });
      const list = await store.addHistory({ method: 'GET', endpoint: '/b', body: '', headers: [] });
      expect(list.map((e) => e.endpoint)).toEqual(['/b', '/a']);
    });

    it('dedupes by method + endpoint + body, moving the match to the front', async () => {
      await store.addHistory({ method: 'GET', endpoint: '/a', body: '', headers: [] });
      await store.addHistory({ method: 'GET', endpoint: '/b', body: '', headers: [] });
      const list = await store.addHistory({ method: 'GET', endpoint: '/a', body: '', headers: [] });
      expect(list.map((e) => e.endpoint)).toEqual(['/a', '/b']);
      expect(list).toHaveLength(2);
    });

    it('treats a different body as a distinct entry', async () => {
      await store.addHistory({ method: 'POST', endpoint: '/a', body: '{"x":1}', headers: [] });
      const list = await store.addHistory({
        method: 'POST',
        endpoint: '/a',
        body: '{"x":2}',
        headers: [],
      });
      expect(list).toHaveLength(2);
    });

    it('excludes headers from the dedupe key', async () => {
      await store.addHistory({
        method: 'GET',
        endpoint: '/a',
        body: '',
        headers: [{ key: 'X-A', value: '1' }],
      });
      const list = await store.addHistory({
        method: 'GET',
        endpoint: '/a',
        body: '',
        headers: [{ key: 'X-B', value: '2' }],
      });
      expect(list).toHaveLength(1);
      expect(list[0].headers).toEqual([{ key: 'X-B', value: '2' }]);
    });

    it('ignores blank endpoints', async () => {
      const list = await store.addHistory({
        method: 'GET',
        endpoint: '   ',
        body: '',
        headers: [],
      });
      expect(list).toEqual([]);
    });

    it('caps the history at 50 entries', async () => {
      for (let i = 0; i < 60; i++) {
        await store.addHistory({ method: 'GET', endpoint: `/q${i}`, body: '', headers: [] });
      }
      const list = await store.addHistory({
        method: 'GET',
        endpoint: '/last',
        body: '',
        headers: [],
      });
      expect(list).toHaveLength(50);
      expect(list[0].endpoint).toBe('/last');
    });
  });

  describe('saveSavedRequests', () => {
    it('stores and caps the list at 50', async () => {
      const store = new RestCallStateStore(makeMemento());
      const many = Array.from({ length: 60 }, (_, i) => ({
        name: `S${i}`,
        method: 'GET',
        endpoint: '/x',
        body: '',
        headers: [],
      }));
      const saved = await store.saveSavedRequests(many);
      expect(saved).toHaveLength(50);
      expect(store.getState().savedRequests).toHaveLength(50);
    });
  });
});

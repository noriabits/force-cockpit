import { describe, expect, it, beforeEach } from 'vitest';
import type { Memento } from 'vscode';
import { QueryStateStore } from './QueryStateStore';

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

describe('QueryStateStore', () => {
  describe('getState', () => {
    it('returns a single default tab when nothing is stored', () => {
      const state = new QueryStateStore(makeMemento()).getState();
      expect(state.tabs).toEqual([
        { name: 'Query 1', query: 'SELECT Id FROM ', useToolingApi: false },
      ]);
      expect(state.activeTab).toBe(0);
      expect(state.history).toEqual([]);
      expect(state.savedQueries).toEqual([]);
    });

    it('returns stored tabs and clamps an out-of-range active index', () => {
      const tabs = [
        { name: 'A', query: 'SELECT Id FROM Account', useToolingApi: false },
        { name: 'B', query: 'SELECT Id FROM Contact', useToolingApi: true },
      ];
      const store = new QueryStateStore(
        makeMemento({ 'quickQuery.tabs': tabs, 'quickQuery.activeTab': 9 }),
      );
      const state = store.getState();
      expect(state.tabs).toEqual(tabs);
      expect(state.activeTab).toBe(0);
    });
  });

  describe('addHistory', () => {
    let store: QueryStateStore;
    beforeEach(() => {
      store = new QueryStateStore(makeMemento());
    });

    it('prepends new entries newest-first', async () => {
      await store.addHistory({ query: 'A', useToolingApi: false });
      const list = await store.addHistory({ query: 'B', useToolingApi: false });
      expect(list.map((e) => e.query)).toEqual(['B', 'A']);
    });

    it('dedupes by query + useToolingApi, moving the match to the front', async () => {
      await store.addHistory({ query: 'A', useToolingApi: false });
      await store.addHistory({ query: 'B', useToolingApi: false });
      const list = await store.addHistory({ query: 'A', useToolingApi: false });
      expect(list.map((e) => e.query)).toEqual(['A', 'B']);
    });

    it('treats a different API type as a distinct entry', async () => {
      await store.addHistory({ query: 'A', useToolingApi: false });
      const list = await store.addHistory({ query: 'A', useToolingApi: true });
      expect(list).toHaveLength(2);
    });

    it('ignores blank queries', async () => {
      const list = await store.addHistory({ query: '   ', useToolingApi: false });
      expect(list).toEqual([]);
    });

    it('caps the history at 50 entries', async () => {
      for (let i = 0; i < 60; i++) {
        await store.addHistory({ query: `Q${i}`, useToolingApi: false });
      }
      const list = await store.addHistory({ query: 'last', useToolingApi: false });
      expect(list).toHaveLength(50);
      expect(list[0].query).toBe('last');
    });
  });

  describe('saveSavedQueries', () => {
    it('stores and caps the list at 50', async () => {
      const store = new QueryStateStore(makeMemento());
      const many = Array.from({ length: 60 }, (_, i) => ({
        name: `S${i}`,
        query: 'x',
        useToolingApi: false,
      }));
      const saved = await store.saveSavedQueries(many);
      expect(saved).toHaveLength(50);
      expect(store.getState().savedQueries).toHaveLength(50);
    });
  });
});

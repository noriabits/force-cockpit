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
    it('starts a fresh workspace on one default tab', () => {
      const state = new RestCallStateStore(makeMemento()).getState();
      expect(state).toEqual({
        tabs: [
          {
            name: 'Request',
            method: 'POST',
            endpoint: '',
            body: '',
            headers: [],
            autoName: true,
            nameObject: null,
          },
        ],
        activeTab: 0,
        history: [],
        savedRequests: [],
      });
    });

    it('carries a pre-tabs request into the first tab rather than dropping it', () => {
      const store = new RestCallStateStore(
        makeMemento({
          'restCall.lastConfig': {
            method: 'GET',
            endpoint: '/x',
            headers: [{ key: 'X-Foo', value: 'bar' }],
          },
        }),
      );
      expect(store.getState().tabs).toEqual([
        {
          name: 'Request',
          method: 'GET',
          endpoint: '/x',
          body: '',
          headers: [{ key: 'X-Foo', value: 'bar' }],
          autoName: true,
          nameObject: null,
        },
      ]);
    });

    it('ignores the pre-tabs request once real tabs exist', () => {
      const store = new RestCallStateStore(
        makeMemento({
          'restCall.lastConfig': { method: 'GET', endpoint: '/old' },
          'restCall.tabs': [
            { name: 'Account', method: 'GET', endpoint: '/new', body: '', headers: [] },
          ],
          'restCall.activeTab': 0,
        }),
      );
      expect(store.getState().tabs).toEqual([
        { name: 'Account', method: 'GET', endpoint: '/new', body: '', headers: [] },
      ]);
    });

    it('clamps an out-of-range active tab back to the first', () => {
      const tabs = [{ name: 'A', method: 'GET', endpoint: '/a', body: '', headers: [] }];
      for (const activeTab of [3, -1]) {
        const store = new RestCallStateStore(
          makeMemento({ 'restCall.tabs': tabs, 'restCall.activeTab': activeTab }),
        );
        expect(store.getState().activeTab).toBe(0);
      }
    });
  });

  describe('saveTabs', () => {
    it('round-trips tabs and the active index', async () => {
      const memento = makeMemento();
      const store = new RestCallStateStore(memento);
      const tabs = [
        { name: 'Account', method: 'GET', endpoint: '/a', body: '', headers: [] },
        {
          name: 'Cases',
          method: 'PATCH',
          endpoint: '/services/apexrest/x',
          body: '{"a":1}',
          headers: [{ key: 'X-Foo', value: 'bar' }],
          autoName: false,
          nameObject: 'x',
        },
      ];
      await store.saveTabs(tabs, 1);
      const state = store.getState();
      expect(state.tabs).toEqual(tabs);
      expect(state.activeTab).toBe(1);
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

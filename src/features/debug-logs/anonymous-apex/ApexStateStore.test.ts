import { describe, expect, it } from 'vitest';
import type { Memento } from 'vscode';
import { ApexStateStore } from './ApexStateStore';

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

describe('ApexStateStore', () => {
  describe('getState', () => {
    it('starts a fresh workspace on one empty, auto-named tab and the recommended preset', () => {
      expect(new ApexStateStore(makeMemento()).getState()).toEqual({
        tabs: [{ name: 'Apex', code: '', autoName: true, nameObject: null }],
        activeTab: 0,
        history: [],
        savedSnippets: [],
        presetId: 'balanced',
      });
    });

    it('round-trips tabs and the active index', async () => {
      const store = new ApexStateStore(makeMemento());
      const tabs = [
        { name: 'UserInfo', code: 'System.debug(UserInfo.getUserName());', autoName: true },
        { name: 'Mine', code: 'insert new Account();', autoName: false },
      ];
      await store.saveTabs(tabs, 1);
      expect(store.getState()).toMatchObject({ tabs, activeTab: 1 });
    });

    it.each([-1, 2, 99])('clamps an out-of-range active index (%i) to 0', (activeTab) => {
      const state = new ApexStateStore(
        makeMemento({
          'anonApex.tabs': [
            { name: 'a', code: '' },
            { name: 'b', code: '' },
          ],
          'anonApex.activeTab': activeTab,
        }),
      ).getState();
      expect(state.activeTab).toBe(0);
    });

    it('falls back to the recommended preset when the stored one no longer exists', () => {
      const state = new ApexStateStore(makeMemento({ 'anonApex.presetId': 'gone' })).getState();
      expect(state.presetId).toBe('balanced');
    });
  });

  describe('savePreset', () => {
    it('stores a known preset and ignores an unknown one', async () => {
      const store = new ApexStateStore(makeMemento());
      await store.savePreset('deep-trace');
      await store.savePreset('not-a-preset');
      expect(store.getState().presetId).toBe('deep-trace');
    });
  });

  describe('addHistory', () => {
    it('puts the newest first and dedups by trimmed code', async () => {
      const store = new ApexStateStore(makeMemento());
      await store.addHistory({ code: 'System.debug(1);' });
      await store.addHistory({ code: 'System.debug(2);' });
      const list = await store.addHistory({ code: '\n  System.debug(1);\n' });
      expect(list).toEqual([{ code: 'System.debug(1);' }, { code: 'System.debug(2);' }]);
    });

    it('ignores blank code and returns the list unchanged', async () => {
      const store = new ApexStateStore(makeMemento());
      await store.addHistory({ code: 'a();' });
      expect(await store.addHistory({ code: '   ' })).toEqual([{ code: 'a();' }]);
    });

    it('caps the list at 50', async () => {
      const store = new ApexStateStore(makeMemento());
      for (let i = 0; i < 55; i++) await store.addHistory({ code: `System.debug(${i});` });
      const list = store.getState().history;
      expect(list).toHaveLength(50);
      expect(list[0].code).toBe('System.debug(54);');
    });
  });

  describe('saveSavedSnippets', () => {
    it('replaces the list, capped at 50', async () => {
      const store = new ApexStateStore(makeMemento());
      const list = Array.from({ length: 60 }, (_, i) => ({ name: `s${i}`, code: `x${i}();` }));
      expect(await store.saveSavedSnippets(list)).toHaveLength(50);
      expect(store.getState().savedSnippets[0]).toEqual({ name: 's0', code: 'x0();' });
    });

    it('treats a non-array as empty', async () => {
      const store = new ApexStateStore(makeMemento());
      expect(await store.saveSavedSnippets(null as never)).toEqual([]);
    });
  });
});

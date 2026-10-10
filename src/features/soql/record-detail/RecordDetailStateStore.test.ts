import { describe, expect, it } from 'vitest';
import type { Memento } from 'vscode';
import type { RecordDetailTab } from '../../../shared/protocol';
import { RecordDetailStateStore } from './RecordDetailStateStore';

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

function tab(recordId: string, name = recordId): RecordDetailTab {
  return { recordId, name, autoName: true, nameObject: null };
}

describe('RecordDetailStateStore', () => {
  it('returns no tabs for an org that has never saved any', () => {
    const store = new RecordDetailStateStore(makeMemento());
    expect(store.getState('00D000000000001EAA')).toEqual({
      orgId: '00D000000000001EAA',
      tabs: [],
      activeTab: 0,
    });
  });

  it('round-trips an org’s tabs and active index', async () => {
    const store = new RecordDetailStateStore(makeMemento());
    const tabs = [tab('001000000000001AAA', 'Acme'), tab('005000000000001AAA', 'User 001AAA')];
    await store.saveTabs('00Dsandbox', tabs, 1);

    expect(store.getState('00Dsandbox')).toEqual({ orgId: '00Dsandbox', tabs, activeTab: 1 });
  });

  it('keeps each org’s tabs apart', async () => {
    const store = new RecordDetailStateStore(makeMemento());
    await store.saveTabs('00Dprod', [tab('001prod')], 0);
    await store.saveTabs('00Dsandbox', [tab('001sbx1'), tab('001sbx2')], 1);

    expect(store.getState('00Dprod').tabs.map((t) => t.recordId)).toEqual(['001prod']);
    expect(store.getState('00Dsandbox').tabs.map((t) => t.recordId)).toEqual([
      '001sbx1',
      '001sbx2',
    ]);
  });

  it('ignores a save that does not say which org it belongs to', async () => {
    const memento = makeMemento();
    const store = new RecordDetailStateStore(memento);
    await store.saveTabs('00Dprod', [tab('001prod')], 0);

    await store.saveTabs(undefined, [tab('001stray')], 0);
    await store.saveTabs(null, [tab('001stray')], 0);

    expect(store.getState('00Dprod').tabs.map((t) => t.recordId)).toEqual(['001prod']);
    expect(Object.keys(memento.get('recordDetail.tabsByOrg', {}))).toEqual(['00Dprod']);
  });

  it('caps the tabs it keeps per org', async () => {
    const store = new RecordDetailStateStore(makeMemento());
    const many = Array.from({ length: 25 }, (_, i) => tab(`001-${i}`));
    await store.saveTabs('00Dprod', many, 24);

    const state = store.getState('00Dprod');
    expect(state.tabs).toHaveLength(20);
    expect(state.tabs[19].recordId).toBe('001-19');
    // The active index was past the cap, so it falls back to the first tab.
    expect(state.activeTab).toBe(0);
  });

  it('clamps an out-of-range active index on the way in and out', async () => {
    const store = new RecordDetailStateStore(
      makeMemento({
        'recordDetail.tabsByOrg': { '00Dprod': { tabs: [tab('001a')], activeTab: 7 } },
      }),
    );
    expect(store.getState('00Dprod').activeTab).toBe(0);

    await store.saveTabs('00Dprod', [tab('001a'), tab('001b')], -1);
    expect(store.getState('00Dprod').activeTab).toBe(0);
  });

  it('keeps only tab-shaped fields — the value crosses postMessage', async () => {
    const store = new RecordDetailStateStore(makeMemento());
    await store.saveTabs(
      '00Dprod',
      [
        { recordId: '001a', name: 'Acme', autoName: false, nameObject: 'Account' },
        // Junk the webview's in-memory tab carries; only the four fields persist.
        { recordId: '001b', name: 'B', edits: { Name: 'x' }, results: {} } as never,
      ],
      0,
    );

    expect(store.getState('00Dprod').tabs).toEqual([
      { recordId: '001a', name: 'Acme', autoName: false, nameObject: 'Account' },
      { recordId: '001b', name: 'B', autoName: true, nameObject: null },
    ]);
  });

  it('survives a corrupt stored value and no connected org', () => {
    const store = new RecordDetailStateStore(
      makeMemento({ 'recordDetail.tabsByOrg': { '00Dprod': { tabs: 'nope' } } }),
    );
    expect(store.getState('00Dprod').tabs).toEqual([]);
    expect(store.getState(null)).toEqual({ orgId: null, tabs: [], activeTab: 0 });
  });
});

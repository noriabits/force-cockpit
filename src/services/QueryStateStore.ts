import type { Memento } from 'vscode';

/** A single query tab. Result rows are NOT persisted (in-memory only in the webview). */
export interface QueryTab {
  name: string;
  query: string;
  useToolingApi: boolean;
}

/** A recent-history entry. Deduped by query + API type. */
export interface QueryHistoryEntry {
  query: string;
  useToolingApi: boolean;
}

/** An explicitly saved/favorite query. */
export interface SavedQuery {
  name: string;
  query: string;
  useToolingApi: boolean;
}

export interface QueryState {
  tabs: QueryTab[];
  activeTab: number;
  history: QueryHistoryEntry[];
  savedQueries: SavedQuery[];
}

const KEY_TABS = 'quickQuery.tabs';
const KEY_ACTIVE = 'quickQuery.activeTab';
const KEY_HISTORY = 'quickQuery.history';
const KEY_SAVED = 'quickQuery.savedQueries';

const HISTORY_CAP = 50;
const SAVED_CAP = 50;

/**
 * Persists Quick Query tabs, recent history, and saved queries in workspaceState.
 * Pure logic over an injected `Memento` so it can be unit-tested with a fake store.
 */
export class QueryStateStore {
  constructor(private readonly memento: Memento) {}

  getState(): QueryState {
    const tabs = this.memento.get<QueryTab[]>(KEY_TABS, []);
    const activeTab = this.memento.get<number>(KEY_ACTIVE, 0);
    return {
      tabs: tabs.length > 0 ? tabs : [{ name: 'Query 1', query: '', useToolingApi: false }],
      activeTab: tabs.length > 0 && activeTab >= 0 && activeTab < tabs.length ? activeTab : 0,
      history: this.memento.get<QueryHistoryEntry[]>(KEY_HISTORY, []),
      savedQueries: this.memento.get<SavedQuery[]>(KEY_SAVED, []),
    };
  }

  async saveTabs(tabs: QueryTab[], activeTab: number): Promise<void> {
    await this.memento.update(KEY_TABS, tabs);
    await this.memento.update(KEY_ACTIVE, activeTab);
  }

  /** Unshift a new entry, dedup by query + useToolingApi, cap to HISTORY_CAP. Returns the new list. */
  async addHistory(entry: QueryHistoryEntry): Promise<QueryHistoryEntry[]> {
    const query = entry.query.trim();
    if (!query) return this.memento.get<QueryHistoryEntry[]>(KEY_HISTORY, []);
    const useToolingApi = !!entry.useToolingApi;
    const existing = this.memento.get<QueryHistoryEntry[]>(KEY_HISTORY, []);
    const deduped = existing.filter(
      (e) => !(e.query === query && e.useToolingApi === useToolingApi),
    );
    const next = [{ query, useToolingApi }, ...deduped].slice(0, HISTORY_CAP);
    await this.memento.update(KEY_HISTORY, next);
    return next;
  }

  /** Replace the saved-query list (cap to SAVED_CAP). Returns the stored list. */
  async saveSavedQueries(list: SavedQuery[]): Promise<SavedQuery[]> {
    const next = list.slice(0, SAVED_CAP);
    await this.memento.update(KEY_SAVED, next);
    return next;
  }
}

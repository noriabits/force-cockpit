import type { Memento } from 'vscode';

export interface HeaderEntry {
  key: string;
  value: string;
}

/** One request's editable content — what a request tab holds. */
export interface RestCallConfig {
  method: string;
  endpoint: string;
  body: string;
  headers: HeaderEntry[];
}

/** A recent-history entry. Deduped by method + endpoint + body (headers excluded from the key). */
export interface RestCallHistoryEntry {
  method: string;
  endpoint: string;
  body: string;
  headers: HeaderEntry[];
}

/** An explicitly saved/named request. */
export interface SavedRestCall {
  name: string;
  method: string;
  endpoint: string;
  body: string;
  headers: HeaderEntry[];
}

/**
 * One request tab. Mirrors `QueryTab` in the SOQL tab's QueryStateStore: the
 * request itself plus the naming flags the shared tab strip needs. In-flight and
 * response state is deliberately not persisted, so a reload restores idle tabs.
 */
export interface RestCallTab extends RestCallConfig {
  name: string;
  /** False once the user renames the tab by hand; blank rename hands it back to auto. */
  autoName?: boolean;
  /** The endpoint base a label adopted from a saved request was taken under. */
  nameObject?: string | null;
}

export interface RestCallState {
  tabs: RestCallTab[];
  activeTab: number;
  history: RestCallHistoryEntry[];
  savedRequests: SavedRestCall[];
}

const KEY_TABS = 'restCall.tabs';
const KEY_ACTIVE = 'restCall.activeTab';
/**
 * Pre-tabs key, holding the single request the REST tab used to have. Still read
 * once, to carry that request into the first tab; nothing writes it any more.
 */
const KEY_LAST_CONFIG = 'restCall.lastConfig';
const KEY_HISTORY = 'restCall.history';
const KEY_SAVED = 'restCall.savedRequests';

const HISTORY_CAP = 50;
const SAVED_CAP = 50;

const DEFAULT_CONFIG: RestCallConfig = { method: 'POST', endpoint: '', body: '', headers: [] };

/** Placeholder name for the migrated tab; the webview re-derives it on load. */
const DEFAULT_TAB_NAME = 'Request';

/**
 * Persists the REST tab's request tabs, recent history, and saved/named requests
 * in workspaceState — the same store the SOQL tab uses (`QueryStateStore`'s pattern).
 * Pure logic over an injected `Memento` for unit-testability.
 */
export class RestCallStateStore {
  constructor(private readonly memento: Memento) {}

  getState(): RestCallState {
    const tabs = this.memento.get<RestCallTab[]>(KEY_TABS, []);
    const activeTab = this.memento.get<number>(KEY_ACTIVE, 0);
    return {
      tabs: tabs.length > 0 ? tabs : [this.migratedTab()],
      activeTab: tabs.length > 0 && activeTab >= 0 && activeTab < tabs.length ? activeTab : 0,
      history: this.memento.get<RestCallHistoryEntry[]>(KEY_HISTORY, []),
      savedRequests: this.memento.get<SavedRestCall[]>(KEY_SAVED, []),
    };
  }

  /**
   * The single tab a workspace starts with: the pre-tabs request when there was
   * one, so upgrading doesn't silently drop what the user had open. Named by the
   * webview — `autoName` makes its `load()` re-derive the label from the endpoint,
   * which keeps the naming rules in one place.
   */
  private migratedTab(): RestCallTab {
    const config = {
      ...DEFAULT_CONFIG,
      ...this.memento.get<Partial<RestCallConfig>>(KEY_LAST_CONFIG, {}),
    };
    return { name: DEFAULT_TAB_NAME, ...config, autoName: true, nameObject: null };
  }

  async saveTabs(tabs: RestCallTab[], activeTab: number): Promise<void> {
    await this.memento.update(KEY_TABS, tabs);
    await this.memento.update(KEY_ACTIVE, activeTab);
  }

  /** Unshift a new entry, dedup by method + endpoint + body, cap to HISTORY_CAP. Returns the new list. */
  async addHistory(entry: RestCallHistoryEntry): Promise<RestCallHistoryEntry[]> {
    const endpoint = entry.endpoint.trim();
    if (!endpoint) return this.memento.get<RestCallHistoryEntry[]>(KEY_HISTORY, []);
    const method = entry.method;
    const body = entry.body ?? '';
    const existing = this.memento.get<RestCallHistoryEntry[]>(KEY_HISTORY, []);
    const deduped = existing.filter(
      (e) => !(e.method === method && e.endpoint === endpoint && e.body === body),
    );
    const next = [{ method, endpoint, body, headers: entry.headers ?? [] }, ...deduped].slice(
      0,
      HISTORY_CAP,
    );
    await this.memento.update(KEY_HISTORY, next);
    return next;
  }

  /** Replace the saved-requests list (cap to SAVED_CAP). Returns the stored list. */
  async saveSavedRequests(list: SavedRestCall[]): Promise<SavedRestCall[]> {
    const next = list.slice(0, SAVED_CAP);
    await this.memento.update(KEY_SAVED, next);
    return next;
  }
}

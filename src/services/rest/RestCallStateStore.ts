import type { Memento } from 'vscode';

export interface HeaderEntry {
  key: string;
  value: string;
}

/** The last-used REST tab request config. Persisted so it survives panel reloads. */
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

export interface RestCallState extends RestCallConfig {
  history: RestCallHistoryEntry[];
  savedRequests: SavedRestCall[];
}

const KEY_LAST_CONFIG = 'restCall.lastConfig';
const KEY_HISTORY = 'restCall.history';
const KEY_SAVED = 'restCall.savedRequests';

const HISTORY_CAP = 50;
const SAVED_CAP = 50;

const DEFAULT_CONFIG: RestCallConfig = { method: 'POST', endpoint: '', body: '', headers: [] };

/**
 * Persists the REST tab's last request config, recent history, and saved/named requests
 * in workspaceState — the same store Quick Query uses (`QueryStateStore`'s pattern).
 * Pure logic over an injected `Memento` for unit-testability.
 */
export class RestCallStateStore {
  constructor(private readonly memento: Memento) {}

  getState(): RestCallState {
    const config = {
      ...DEFAULT_CONFIG,
      ...this.memento.get<Partial<RestCallConfig>>(KEY_LAST_CONFIG, {}),
    };
    return {
      ...config,
      history: this.memento.get<RestCallHistoryEntry[]>(KEY_HISTORY, []),
      savedRequests: this.memento.get<SavedRestCall[]>(KEY_SAVED, []),
    };
  }

  async save(config: RestCallConfig): Promise<void> {
    await this.memento.update(KEY_LAST_CONFIG, {
      method: config.method,
      endpoint: config.endpoint,
      body: config.body,
      headers: config.headers,
    });
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

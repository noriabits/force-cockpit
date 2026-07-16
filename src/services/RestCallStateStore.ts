import type { Memento } from 'vscode';

/** The last-used REST tab request config. Persisted so it survives panel reloads. */
export interface RestCallConfig {
  method: string;
  endpoint: string;
  body: string;
}

const KEY = 'restCall.lastConfig';

const DEFAULT_CONFIG: RestCallConfig = { method: 'POST', endpoint: '', body: '' };

/**
 * Persists the REST tab's last request config in workspaceState — the same store
 * Quick Query uses. Pure logic over an injected `Memento` for unit-testability.
 */
export class RestCallStateStore {
  constructor(private readonly memento: Memento) {}

  getState(): RestCallConfig {
    return { ...DEFAULT_CONFIG, ...this.memento.get<Partial<RestCallConfig>>(KEY, {}) };
  }

  async save(config: RestCallConfig): Promise<void> {
    await this.memento.update(KEY, {
      method: config.method,
      endpoint: config.endpoint,
      body: config.body,
    });
  }
}

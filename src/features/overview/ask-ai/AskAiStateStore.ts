// Remembers the Overview tab's "Ask the AI" panel choices between sessions
// (workspaceState-backed, same pattern as DebugLogsStateStore/RestCallStateStore).
// Pure apart from the injected Memento, so it is unit-testable with a plain object.
const KEY = 'askAi.state';

export interface AskAiState {
  /** Model id, or '' for auto. */
  modelId: string;
  allowWorkspaceFiles: boolean;
  allowOrgQueries: boolean;
}

export const DEFAULT_STATE: AskAiState = {
  modelId: '',
  allowWorkspaceFiles: true,
  // Both tools are strictly read-only (SELECT-only SOQL + describe), and this
  // card only renders once an org is connected — org Q&A is the whole point.
  allowOrgQueries: true,
};

interface MementoLike {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

export class AskAiStateStore {
  constructor(private readonly memento: MementoLike) {}

  getState(): AskAiState {
    const stored = this.memento.get<Partial<AskAiState>>(KEY, {});
    return { ...DEFAULT_STATE, ...stored };
  }

  async save(patch: Partial<AskAiState>): Promise<AskAiState> {
    const next = { ...this.getState(), ...patch };
    await this.memento.update(KEY, next);
    return next;
  }
}

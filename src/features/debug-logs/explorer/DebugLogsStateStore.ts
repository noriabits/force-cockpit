// Remembers the panel's choices between sessions (workspaceState-backed, same
// pattern as RestCallStateStore). Pure apart from the injected Memento, so it
// is unit-testable with a plain object.
import type { CategoryLevels } from './types';
import { RECOMMENDED_PRESET_ID } from './debugLevelPresets';

const KEY = 'debugLogs.state';

export interface DebugLogsState {
  presetId: string;
  durationMs: number;
  customLevels: CategoryLevels | null;
  /** Model id for the AI analysis, or '' for auto. */
  modelId: string;
  allowWorkspaceFiles: boolean;
  allowOrgQueries: boolean;
  hideEmptyLogs: boolean;
  errorsOnly: boolean;
  liveTail: boolean;
}

export const DEFAULT_STATE: DebugLogsState = {
  presetId: RECOMMENDED_PRESET_ID,
  durationMs: 30 * 60 * 1000,
  customLevels: null,
  modelId: '',
  allowWorkspaceFiles: true,
  allowOrgQueries: false,
  hideEmptyLogs: false,
  errorsOnly: false,
  liveTail: true,
};

interface MementoLike {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

export class DebugLogsStateStore {
  constructor(private readonly memento: MementoLike) {}

  getState(): DebugLogsState {
    const stored = this.memento.get<Partial<DebugLogsState>>(KEY, {});
    return { ...DEFAULT_STATE, ...stored };
  }

  async save(patch: Partial<DebugLogsState>): Promise<DebugLogsState> {
    const next = { ...this.getState(), ...patch };
    await this.memento.update(KEY, next);
    return next;
  }
}

// Remembers the panel's choices between sessions. The get/merge/save mechanics
// live in the shared MementoStore; only the key, the shape and the defaults are
// this feature's own.
import type { CategoryLevels } from './types';
import { RECOMMENDED_PRESET_ID } from './debugLevelPresets';
import { MementoStore, type MementoLike } from '../../../services/state/MementoStore';

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

/** Binds the key and defaults; the get/merge/save mechanics are MementoStore's. */
export const createDebugLogsStateStore = (memento: MementoLike): MementoStore<DebugLogsState> =>
  new MementoStore(memento, KEY, DEFAULT_STATE);

// Remembers the Overview tab's "Ask the AI" panel choices between sessions.
// The get/merge/save mechanics live in the shared MementoStore; only the key,
// the shape and the defaults are this feature's own.
import { MementoStore, type MementoLike } from '../../../services/state/MementoStore';

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

/** Binds the key and defaults; the get/merge/save mechanics are MementoStore's. */
export const createAskAiStateStore = (memento: MementoLike): MementoStore<AskAiState> =>
  new MementoStore(memento, KEY, DEFAULT_STATE);

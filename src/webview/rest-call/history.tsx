// The REST tab's binding for the shared history dropdown
// (src/features/shared/view/history-dropdown.tsx), which owns the panel, the
// two sections, the ★ Save row and every `.query-history-*` class. This file
// says only what a REST request is: how a row reads, what counts as empty, and
// the two message names the lists persist under.
//
// The public shape is unchanged — `createRestCallHistory(ctx)` still returns
// { load, recordRun, onHistoryUpdated, onSavedUpdated } over the same
// pre-existing DOM elements — so `rest-controller.tsx` was untouched by the
// extraction, and `rest-flow.test.tsx` needed no edits.
//
// Persistence lives host-side (RestCallStateStore); the two posts below are
// literal message names, which is what keeps the protocol union able to see
// them (the shared core posts nothing — see its header).

import {
  createHistoryDropdown,
  type HistoryDropdownCtx,
} from '../../features/shared/view/history-dropdown';

export interface HeaderEntry {
  key: string;
  value: string;
}
export interface RestHistoryEntry {
  method: string;
  endpoint: string;
  body: string;
  headers: HeaderEntry[];
}
export interface SavedRestCall extends RestHistoryEntry {
  name: string;
}
/** A row's payload plus, for a Saved row only, the label the opened tab adopts. */
export type PickedEntry = RestHistoryEntry & { name?: string };

type SharedCtx = HistoryDropdownCtx<RestHistoryEntry>;

export interface RestCallHistoryCtx {
  /** "History ▾" toggle. */
  buttonEl: HTMLButtonElement;
  /** Mount container for the panel — see the shared component's header. */
  dropdownEl: HTMLElement;
  /** "★ Save" current request. */
  saveBtn: HTMLButtonElement;
  vscode: { postMessage: (msg: unknown) => void };
  getCurrent: () => RestHistoryEntry;
  onPick: (entry: PickedEntry) => void;
  /**
   * Name to pre-fill the save input with — the active tab's own title, whether
   * auto-derived, hand-renamed or adopted from a saved entry. Pre-selected, so
   * typing still replaces it.
   */
  getDefaultName?: () => string;
  /**
   * Called once a Save is confirmed, with the name it was saved under — lets the
   * caller relabel the tab that was just saved to match, so the box the user just
   * typed a name into and the tab they're looking at never disagree.
   */
  onSaved?: (name: string) => void;
}

/** An empty endpoint is nothing to send, so nothing to save or record either. */
const isEmpty = (entry: RestHistoryEntry) => !entry.endpoint.trim();

export function createRestCallHistory(ctx: RestCallHistoryCtx) {
  const panel = createHistoryDropdown<RestHistoryEntry>({
    buttonEl: ctx.buttonEl,
    dropdownEl: ctx.dropdownEl,
    saveBtn: ctx.saveBtn,

    // The method is already in the badge, so the row text is just the endpoint.
    textOf: (item) => item.endpoint,
    tooltipOf: (item) => `${item.method} ${item.endpoint}`,
    badgeOf: (item) => item.method,

    getCurrent: ctx.getCurrent,
    isEmpty,
    getDefaultName: () => ctx.getDefaultName?.() ?? '',

    onPick: (entry) => ctx.onPick(entry),
    persistSaved: (savedRequests) =>
      ctx.vscode.postMessage({ type: 'saveRestCallSavedRequests', savedRequests }),
    onSaved: (name) => ctx.onSaved?.(name),

    copy: {
      savePlaceholder: 'Name this request…',
      emptySaved: 'No saved requests.',
      emptyRecent: 'No recent requests.',
      removeTooltip: 'Remove saved request',
    },
  } satisfies SharedCtx);

  return {
    load(loaded: { history?: RestHistoryEntry[]; savedRequests?: SavedRestCall[] }) {
      panel.setHistory(loaded.history);
      panel.setSaved(loaded.savedRequests);
    },
    /** Called only on a completed run (success — including non-2xx — never on send). */
    recordRun(entry: RestHistoryEntry) {
      if (isEmpty(entry)) return;
      ctx.vscode.postMessage({ type: 'addRestCallHistory', ...entry });
    },
    onHistoryUpdated(list: RestHistoryEntry[]) {
      panel.setHistory(list);
    },
    onSavedUpdated(list: SavedRestCall[]) {
      panel.setSaved(list);
    },
  };
}

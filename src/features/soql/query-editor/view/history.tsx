// The SOQL tab's binding for the shared history dropdown
// (src/features/shared/view/history-dropdown.tsx), which owns the panel, the
// two sections, the ★ Save row and every `.query-history-*` class. This file
// says only what a query is: how a row reads, what counts as empty, and the two
// message names the lists persist under.
//
// The public shape is unchanged — `createQueryHistory(ctx)` still returns
// { load, recordRun, onHistoryUpdated, onSavedUpdated } over the same
// pre-existing DOM elements — so `view/index.js` was untouched by the port
// (esbuild and Vitest both resolve `./history` to this `.tsx`), and
// `history.test.tsx` needed no edits.
//
// This is where Preact enters the SOQL bundle. The rest of `view/` is still
// imperative and migrates as it is touched, per CLAUDE.md — so for now this is
// one Preact island inside an orchestrator built on getElementById.
//
// Persistence lives host-side (QueryStateStore); the two posts below are
// literal message names, which is what keeps the protocol union able to see
// them (the shared core posts nothing — see its header).

import {
  createHistoryDropdown,
  type HistoryDropdownCtx,
} from '../../../shared/view/history-dropdown';

export interface HistoryEntry {
  query: string;
  useToolingApi: boolean;
}
export interface SavedQuery extends HistoryEntry {
  name: string;
}
/** A row's payload plus, for a Saved row only, the label the opened tab adopts. */
export type PickedQuery = HistoryEntry & { name?: string };

type SharedCtx = HistoryDropdownCtx<HistoryEntry>;

export interface QueryHistoryCtx {
  /** "History ▾" toggle. */
  buttonEl: HTMLButtonElement;
  /** Mount container for the panel — see the shared component's header. */
  dropdownEl: HTMLElement;
  /** "★ Save" current query. */
  saveBtn: HTMLButtonElement;
  vscode: { postMessage: (msg: unknown) => void };
  getCurrent: () => HistoryEntry;
  onPick: (entry: PickedQuery) => void;
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

/** A blank editor is nothing to run, so nothing to save or record either. */
const isEmpty = (entry: HistoryEntry) => !entry.query.trim();

export function createQueryHistory(ctx: QueryHistoryCtx) {
  const panel = createHistoryDropdown<HistoryEntry>({
    buttonEl: ctx.buttonEl,
    dropdownEl: ctx.dropdownEl,
    saveBtn: ctx.saveBtn,

    // The whole query, elided by the core; the tooltip keeps it untruncated.
    textOf: (item) => item.query,
    tooltipOf: (item) => item.query,
    // Conditional, unlike REST's method badge: a Standard-API query is the
    // default and says so by carrying no badge at all.
    badgeOf: (item) => (item.useToolingApi ? 'Tooling' : null),

    getCurrent: ctx.getCurrent,
    isEmpty,
    getDefaultName: () => ctx.getDefaultName?.() ?? '',

    onPick: (entry) => ctx.onPick(entry),
    persistSaved: (savedQueries) =>
      ctx.vscode.postMessage({ type: 'saveSavedQueries', savedQueries }),
    onSaved: (name) => ctx.onSaved?.(name),

    copy: {
      savePlaceholder: 'Name this query…',
      emptySaved: 'No saved queries.',
      emptyRecent: 'No recent queries.',
      removeTooltip: 'Remove saved query',
    },
  } satisfies SharedCtx);

  return {
    load(state: { history?: HistoryEntry[]; savedQueries?: SavedQuery[] }) {
      panel.setHistory(state.history);
      panel.setSaved(state.savedQueries);
    },
    /** Called only on a completed run, with the query that actually ran. */
    recordRun(query: string, useToolingApi: boolean) {
      if (isEmpty({ query, useToolingApi })) return;
      ctx.vscode.postMessage({ type: 'addQueryHistory', query, useToolingApi });
    },
    onHistoryUpdated(list: HistoryEntry[]) {
      panel.setHistory(list);
    },
    onSavedUpdated(list: SavedQuery[]) {
      panel.setSaved(list);
    },
  };
}

// The ▶️ Apex tab's binding for the shared history dropdown
// (src/features/shared/view/history-dropdown.tsx) — its third consumer, and it
// passes the core's admission test: ZERO new ctx fields. Everything the core
// needs is a function of the snippet text, so this file says only how a row
// reads, what counts as empty, and the two literal message names the lists
// persist under (the core posts nothing — see its header).

import {
  createHistoryDropdown,
  type HistoryDropdownCtx,
} from '../../../shared/view/history-dropdown';
import type { ApexSnippet, SavedApexSnippet } from '../../../../shared/protocol';

/** A row's snippet plus, for a Saved row only, the label the opened tab adopts. */
export type PickedSnippet = ApexSnippet & { name?: string };

export interface ApexHistoryCtx {
  buttonEl: HTMLButtonElement;
  dropdownEl: HTMLElement;
  saveBtn: HTMLButtonElement;
  vscode: { postMessage: (msg: unknown) => void };
  getCurrent: () => ApexSnippet;
  onPick: (entry: PickedSnippet) => void;
  getDefaultName: () => string;
  onSaved: (name: string) => void;
}

/** Blank code is nothing to run, so nothing to save or record either. */
const isEmpty = (entry: ApexSnippet) => !entry.code.trim();

export function createApexHistory(ctx: ApexHistoryCtx) {
  const panel = createHistoryDropdown<ApexSnippet>({
    buttonEl: ctx.buttonEl,
    dropdownEl: ctx.dropdownEl,
    saveBtn: ctx.saveBtn,

    // The core collapses whitespace and elides, so a multi-line snippet reads as
    // its opening statements; the tooltip keeps all of it.
    textOf: (item) => item.code,
    tooltipOf: (item) => item.code,
    badgeOf: () => null,

    getCurrent: ctx.getCurrent,
    isEmpty,
    getDefaultName: ctx.getDefaultName,

    onPick: (entry) => ctx.onPick(entry),
    persistSaved: (savedSnippets) =>
      ctx.vscode.postMessage({ type: 'saveApexSavedSnippets', savedSnippets }),
    onSaved: ctx.onSaved,

    copy: {
      savePlaceholder: 'Name this snippet…',
      emptySaved: 'No saved snippets.',
      emptyRecent: 'No recent snippets.',
      removeTooltip: 'Remove saved snippet',
    },
  } satisfies HistoryDropdownCtx<ApexSnippet>);

  return {
    load(state: { history?: ApexSnippet[]; savedSnippets?: SavedApexSnippet[] }) {
      panel.setHistory(state.history);
      panel.setSaved(state.savedSnippets);
    },
    /** Called only once a run came back, with the code that actually ran. */
    recordRun(code: string) {
      if (isEmpty({ code })) return;
      ctx.vscode.postMessage({ type: 'addApexHistory', code });
    },
    onHistoryUpdated(list: ApexSnippet[]) {
      panel.setHistory(list);
    },
    onSavedUpdated(list: SavedApexSnippet[]) {
      panel.setSaved(list);
    },
  };
}

// Everything the ▶️ Apex tab does that is not rendering: the editor state, the
// shared tab strip's readUI/writeUI contract, run tracking, and the host reply
// handlers. No JSX — this is the seam apex-flow.test.tsx drives.
//
// Modelled on the REST tab's controller (src/webview/rest-call/rest-controller.tsx),
// for the same reasons, which its header records: signals from a factory rather
// than `useSignal` (tab-strip.js and the host handlers call in from outside any
// render), and `runningOpId` as a MIRROR of the active tab's opId rather than a
// `computed` (the strip's tab list is a plain array, not reactive) — so every
// site that changes which run is visible calls `syncRunState`.
//
// Run tracking is the shared tab runner (shared/view/tab-runner.ts), as in the
// REST tab. opIds are `apex-N`, disjoint from `op-N`, `soql-N`, `rest-N`,
// `detail-N` and `plugin-N`.
//
// TWO NON-PREACT COLLABORATORS: the history dropdown (its own render root) and
// the Debug Logs tab's imperative log viewer, which owns the static log card in
// view.html. The controller decides when the viewer shows what; the viewer owns
// everything inside it.

import { signal, type Signal } from '@preact/signals';
import type {
  AnonymousApexLog,
  AnonymousApexOutcome,
  ApexSnippet,
  ApexState,
  ExecuteAnonymousApexMessage,
  SavedApexSnippet,
} from '../../../../shared/protocol';
import { createTabStrip } from '../../../shared/view/tab-strip';
import { createTabRunner } from '../../../shared/view/tab-runner';
import { copyTextWithFeedback, openContentInEditor } from '../../../shared/view/output-actions';
import { RECOMMENDED_PRESET_ID } from '../../explorer/debugLevelPresets';
import { createLogViewer } from '../../explorer/view/log-viewer';
import { createApexHistory } from './history';
import { apexBaseName } from './apex-tab-name';

/** What the outcome panel shows for the active tab. */
export type ApexDisplay =
  | { kind: 'outcome'; outcome: AnonymousApexOutcome }
  | { kind: 'error'; message: string }
  | { kind: 'cancelled' }
  | null;

/** A tab's stored failure — opaque to the strip, which only holds it. */
type TabError = { message: string } | { cancelled: true };

export interface ApexViewState {
  code: Signal<string>;
  presetId: Signal<string>;
  /** The active tab's in-flight opId. See the header. */
  runningOpId: Signal<string | null>;
  display: Signal<ApexDisplay>;
}

export function createApexState(): ApexViewState {
  return {
    code: signal(''),
    presetId: signal(RECOMMENDED_PRESET_ID),
    runningOpId: signal<string | null>(null),
    display: signal<ApexDisplay>(null),
  };
}

/** DOM the imperative collaborators own outright — see apex-tab.tsx. */
export interface ApexElements {
  tabBarEl: HTMLElement;
  textareaEl: HTMLTextAreaElement;
  historyButtonEl: HTMLButtonElement;
  historyDropdownEl: HTMLElement;
  historySaveBtn: HTMLButtonElement;
}

interface CockpitWindow {
  __vscode: { postMessage: (msg: unknown) => void };
  __escapeHtml: (s: string) => string;
  __orgConnected?: boolean;
  __currentOrg?: unknown;
  __confirmIfSensitive: (org: unknown, label: string, onConfirmed: () => void) => void;
  __newApexScript?: (code: string) => void;
  AnonymousApexLabels: Record<string, string>;
}
const win = () => window as unknown as CockpitWindow;
const L = () => win().AnonymousApexLabels;

interface StripTab extends ApexSnippet {
  name: string;
  opId?: string | null;
  results?: AnonymousApexOutcome | null;
  error?: TabError | null;
}

export function createApexController(state: ApexViewState) {
  const vscode = { postMessage: (msg: unknown) => win().__vscode.postMessage(msg) };

  let tabs: ReturnType<typeof createTabStrip>;
  let history: ReturnType<typeof createApexHistory>;
  let viewer: ReturnType<typeof createLogViewer> | null = null;
  let textarea: HTMLTextAreaElement;

  /** Code in flight, by opId — what history records once the run settles. */
  const runs = createTabRunner<StripTab, string>({ tabs: () => tabs, vscode, prefix: 'apex' });

  /** The log viewer, built on first use: its markup is view.html's, not ours. */
  function logViewer() {
    if (!viewer && document.getElementById('apex-viewer-card')) {
      viewer = createLogViewer({ escapeHtml: win().__escapeHtml, idPrefix: 'apex' });
    }
    return viewer;
  }

  function showLog(log: AnonymousApexLog | null | undefined, scroll: boolean) {
    const v = logViewer();
    if (!v) return;
    if (!log) return v.hide();
    v.show(log, null, { title: L().logTitle, scroll });
  }

  /** Paint whatever the given tab last produced — an outcome, a failure, or nothing. */
  function renderTabOutput(tab: StripTab | undefined, scroll = false) {
    const error = tab?.error;
    if (tab?.results) state.display.value = { kind: 'outcome', outcome: tab.results };
    else if (error && 'cancelled' in error) state.display.value = { kind: 'cancelled' };
    else if (error) state.display.value = { kind: 'error', message: error.message };
    else state.display.value = null;
    showLog(tab?.results?.log, scroll);
  }

  function syncRunState(tab: StripTab | undefined) {
    state.runningOpId.value = tab?.opId ?? null;
  }

  function stopAllRuns() {
    runs.stopAll();
    syncRunState(tabs.getActive());
  }

  /**
   * Run `code` on behalf of `tab`. Both are captured by the caller at click time:
   * the sensitive-org confirmation is asynchronous, so by the time this runs the
   * user may have edited the editor or switched tabs.
   */
  function dispatch(tab: StripTab, code: string, presetId: string) {
    runs.start(tab, code, (opId) => {
      const request: ExecuteAnonymousApexMessage = {
        type: 'executeAnonymousApex',
        opId,
        code,
        presetId,
      };
      vscode.postMessage(request);
    });
    if (tab === tabs.getActive()) renderTabOutput(tab);
    syncRunState(tabs.getActive());
  }

  function execute() {
    // Fold the live editor into the active tab first, so what runs and what the
    // tab holds can never disagree.
    tabs.onActiveEdited();
    const tab = tabs.getActive() as StripTab;
    const code = state.code.value;
    if (!code.trim()) return void (state.display.value = { kind: 'error', message: L().emptyCode });
    if (!win().__orgConnected) {
      return void (state.display.value = { kind: 'error', message: L().notConnected });
    }
    const presetId = state.presetId.value;
    // Anonymous Apex can run DML, so it ALWAYS goes through the sensitive-org
    // gate; __confirmIfSensitive no-ops straight to the callback on a sandbox.
    win().__confirmIfSensitive(win().__currentOrg, L().confirmExecute, () =>
      dispatch(tab, code, presetId),
    );
  }

  /**
   * Apex has no true cancel: the SOAP call is already on the server. The host
   * stops waiting and posts nothing; the tab records that it was cancelled and
   * says the transaction may still complete.
   */
  function cancelActiveRun() {
    const tab = tabs.getActive() as StripTab;
    const opId = tabs.getActiveOpId();
    if (!opId) return;
    runs.stop(opId);
    tabs.settleRun(tab, null, { cancelled: true });
    renderTabOutput(tab);
    syncRunState(tab);
  }

  /** Select a compile error's line (and column onwards) in the editor. */
  function goToLine(line: number, column: number | null) {
    const lines = state.code.value.split('\n');
    const index = Math.min(Math.max(line, 1), lines.length) - 1;
    const start = lines.slice(0, index).reduce((sum, l) => sum + l.length + 1, 0);
    const end = start + lines[index].length;
    const from = column ? Math.min(start + column - 1, end) : start;
    textarea.focus();
    textarea.setSelectionRange(from, end);
  }

  function setPreset(presetId: string) {
    state.presetId.value = presetId;
    vscode.postMessage({ type: 'saveApexPreset', presetId });
  }

  /** Raw log text of the active tab's last run — the shipped body, or the shown lines. */
  function activeLogText() {
    const log = (tabs.getActive() as StripTab | undefined)?.results?.log;
    if (!log) return '';
    return log.body || (logViewer()?.getRawText() ?? '');
  }

  function attach(els: ApexElements) {
    textarea = els.textareaEl;

    tabs = createTabStrip({
      tabBarEl: els.tabBarEl,
      vscode,
      persistType: 'saveApexTabs',
      addTooltip: 'New Apex tab',
      newPayload: () => ({ code: '' }),
      payloadOf: (record: { code?: unknown }) => ({
        code: typeof record.code === 'string' ? record.code : '',
      }),
      readUI: () => ({ code: state.code.value }),
      writeUI: (tab: ApexSnippet) => {
        state.code.value = tab.code;
      },
      baseNameFor: (tab: ApexSnippet) => apexBaseName(tab.code),
      isPristine: (tab: ApexSnippet) => !(tab.code || '').trim(),
      onActivate: (tab: StripTab) => {
        renderTabOutput(tab);
        syncRunState(tab);
      },
      onTabClosed: (tab: StripTab) => runs.stop(tab.opId),
    });

    history = createApexHistory({
      buttonEl: els.historyButtonEl,
      dropdownEl: els.historyDropdownEl,
      saveBtn: els.historySaveBtn,
      vscode,
      getCurrent: () => ({ code: state.code.value }),
      getDefaultName: () => tabs.getActive()?.name ?? '',
      // Its own tab (or a pristine active one), so a pick never destroys open work.
      onPick: (entry) => tabs.openTab({ payload: { code: entry.code }, name: entry.name }),
      onSaved: (name) => tabs.renameActiveAsSaved(name),
    });

    // The log viewer's own two actions, which sit in its static card.
    const openRaw = document.getElementById('apex-open-raw');
    const copyLog = document.getElementById('apex-copy-log') as HTMLButtonElement | null;
    openRaw?.addEventListener('click', () => openContentInEditor(activeLogText(), vscode));
    copyLog?.addEventListener('click', () => copyTextWithFeedback(copyLog, activeLogText()));
  }

  /** The host reply handlers, registered by index.tsx once the tree is mounted. */
  const handlers = {
    anonymousApexExecuted(msg: { data?: AnonymousApexOutcome & { opId?: string } }) {
      const owner = runs.claim(msg);
      if (!owner) return;
      const { tab, payload: code } = owner;
      tabs.settleRun(tab, msg.data, null);
      // Record what actually ran, not what the editor holds now.
      if (code !== undefined) history.recordRun(code);
      if (tab !== tabs.getActive()) return;
      renderTabOutput(tab, true);
      syncRunState(tab);
    },
    anonymousApexError(msg: { data?: { opId?: string; message: string } }) {
      const owner = runs.claim(msg);
      if (!owner) return;
      const { tab } = owner;
      tabs.settleRun(tab, null, { message: msg.data!.message });
      if (tab !== tabs.getActive()) return;
      renderTabOutput(tab);
      syncRunState(tab);
    },
    apexStateLoaded(msg: { data?: Partial<ApexState> }) {
      const loaded = msg.data || {};
      if (loaded.presetId) state.presetId.value = loaded.presetId;
      tabs.load(loaded);
      history.load(loaded);
    },
    apexHistoryUpdated(msg: { data?: { history: ApexSnippet[] } }) {
      history.onHistoryUpdated(msg.data!.history);
    },
    apexSavedSnippetsUpdated(msg: { data?: { savedSnippets: SavedApexSnippet[] } }) {
      history.onSavedUpdated(msg.data!.savedSnippets);
    },
    cancelAllOperations: () => stopAllRuns(),
  };

  return {
    attach,
    handlers,
    execute,
    cancelActiveRun,
    stopAllRuns,
    goToLine,
    setPreset,
    cloneActiveTab: () => tabs.cloneActive(),
    saveAsScript: () => win().__newApexScript?.(state.code.value),
    /** Fold a live-editor edit into the active tab. Bound to the textarea. */
    onEdited: () => tabs.onActiveEdited(),
  };
}

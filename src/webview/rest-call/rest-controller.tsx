// Everything the REST tab does that is not rendering: the form state, the tab
// strip's readUI/writeUI contract, run tracking, and the host reply handlers.
// No JSX — this is the seam rest-flow.test.tsx drives.
//
// WHY SIGNALS FROM A FACTORY, NOT `useSignal`. The REST tab is a singleton, so
// per-instance hook state buys nothing; more importantly, `readUI`/`writeUI` are
// called by tab-strip.js from its own event handlers, and the host reply handlers
// are registered at module scope — both outside any render, where hook state is
// unreachable. Reading a signal outside a render creates no subscription, so a
// plain signal bag works from both sides.
//
// This also removes the old shape where THE DOM WAS THE MODEL: `readUI` used to
// read `endpointEl.value` back out of the input it had just written.
//
// The headers deliberately stay OUT of the bag. headers-editor.js owns its own
// array and its own DOM, and it is shared with yaml-scripts' imperative `rest:`
// form, so it must not change. That makes the readUI/writeUI contract half
// signal, half imperative — an asymmetry to leave alone: "tidying" readUI into a
// pure signal read is what would silently break the blank-header-row rule below.

import { signal, type Signal } from '@preact/signals';
import { createTabStrip } from '../../features/shared/view/tab-strip';
import { createHeadersEditor } from '../../features/shared/view/headers-editor';
import { createRestCallHistory, type HeaderEntry, type RestHistoryEntry } from './history';
import { createResponseView, type RestResponseData } from './response-view';
import { endpointBaseName } from './rest-tab-name';

/** Verbs that mutate org data — gated behind sensitive-org confirmation. */
const DESTRUCTIVE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface RestState {
  method: Signal<string>;
  endpoint: Signal<string>;
  body: Signal<string>;
  /**
   * The active tab's in-flight opId, mirrored here so the toolbar can render
   * from it. It CANNOT be a computed: the tab list lives in a plain mutable array
   * inside tab-strip.js, which is shared with the SOQL tab and is not reactive.
   * Every site that used to call paintSendState() now calls syncSendState() with
   * the same argument — miss one and the Send button sticks.
   */
  runningOpId: Signal<string | null>;
}

export function createRestState(): RestState {
  return {
    method: signal('GET'),
    endpoint: signal(''),
    body: signal(''),
    runningOpId: signal<string | null>(null),
  };
}

/** The DOM the imperative collaborators own outright — see rest-tab.tsx. */
export interface RestElements {
  tabBarEl: HTMLElement;
  headersListEl: HTMLElement;
  addHeaderBtn: HTMLButtonElement;
  responseEl: HTMLElement;
  errorEl: HTMLElement;
  historyButtonEl: HTMLButtonElement;
  historyDropdownEl: HTMLElement;
  historySaveBtn: HTMLButtonElement;
}

interface CockpitWindow {
  __vscode: { postMessage: (msg: unknown) => void };
  __orgConnected?: boolean;
  __currentOrg?: unknown;
  __confirmIfSensitive: (org: unknown, label: string, onConfirmed: () => void) => void;
  __registerFeature: (id: string, handlers: Record<string, () => void>) => void;
}
const win = () => window as unknown as CockpitWindow;

export function createRestController(state: RestState) {
  const vscode = { postMessage: (msg: unknown) => win().__vscode.postMessage(msg) };

  let tabs: ReturnType<typeof createTabStrip>;
  let headersEditor: ReturnType<typeof createHeadersEditor>;
  let responseView: ReturnType<typeof createResponseView>;
  let history: ReturnType<typeof createRestCallHistory>;

  let opSeq = 0;
  /** Requests in flight, by opId — the record history is written from once one settles. */
  const pendingRuns = new Map<string, RestHistoryEntry>();

  /** The request as the live form holds it right now. Blank header rows dropped. */
  const getCurrent = (): RestHistoryEntry => ({
    method: state.method.value,
    endpoint: state.endpoint.value,
    body: state.body.value,
    headers: headersEditor.getHeaders(),
  });

  /** Paint whatever the given tab last produced — a response, an error, or nothing. */
  function renderTabOutput(tab: { results?: RestResponseData; error?: string } | undefined) {
    if (tab?.results) responseView.showResponse(tab.results);
    else if (tab?.error) responseView.showError(tab.error);
    else responseView.hideResponse();
  }

  /** Mirror one tab's run state into the toolbar. See RestState.runningOpId. */
  function syncSendState(tab: { opId?: string | null } | undefined) {
    state.runningOpId.value = tab?.opId ?? null;
  }

  function stopRun(opId: string | null | undefined) {
    if (!opId) return;
    pendingRuns.delete(opId);
    vscode.postMessage({ type: 'cancelOperation', opId });
    vscode.postMessage({ type: 'operationEnded', opId });
  }

  function stopAllRuns() {
    for (const opId of tabs.getRunningOpIds()) stopRun(opId);
    tabs.clearAllOpIds();
    syncSendState(tabs.getActive());
  }

  /**
   * The tab a reply belongs to, or null when it has none — closed, cancelled or
   * superseded — in which case the reply is dropped. The operation is ended
   * either way, so the host does not stay busy over a reply nobody wanted.
   */
  function ownerOf(msg: { data?: { opId?: string } }) {
    const opId = msg.data?.opId;
    const tab = tabs.findByOpId(opId);
    if (opId) vscode.postMessage({ type: 'operationEnded', opId });
    if (!tab) return null;
    return { tab, opId: opId as string };
  }

  /**
   * Send `request` on behalf of `tab`. Both are captured by the caller rather than
   * re-read here: the sensitive-org confirmation is asynchronous, so by the time
   * this runs the user may have edited the form or switched to another tab.
   */
  function dispatchSend(tab: Record<string, unknown>, request: RestHistoryEntry) {
    const opId = 'rest-' + ++opSeq;
    if (tab === tabs.getActive()) responseView.hideResponse();
    tabs.settleRun(tab, null, null);
    pendingRuns.set(opId, request);
    tab.opId = opId;
    syncSendState(tabs.getActive());
    vscode.postMessage({ type: 'restCall', ...request, opId });
    // Lets the host count this as busy, so switching orgs mid-request warns first.
    vscode.postMessage({ type: 'operationStarted', opId });
  }

  function send() {
    // Fold the live form into the active tab first, so what is sent and what the
    // tab holds can never disagree.
    tabs.onActiveEdited();
    const tab = tabs.getActive();
    const request = getCurrent();
    request.endpoint = request.endpoint.trim();
    if (!request.endpoint) return responseView.showError('Enter an endpoint path.');
    if (!win().__orgConnected) return responseView.showError('Not connected to any org.');

    const go = () => dispatchSend(tab, request);
    // Destructive verbs on a sensitive org (production / protected sandbox) require
    // confirmation; __confirmIfSensitive no-ops straight to the callback otherwise.
    if (DESTRUCTIVE_METHODS.has((request.method || '').toUpperCase())) {
      win().__confirmIfSensitive(win().__currentOrg, 'Send this REST request?', go);
    } else {
      go();
    }
  }

  function cancelActiveRun() {
    const activeTab = tabs.getActive();
    stopRun(tabs.getActiveOpId());
    tabs.setActiveOpId(null);
    syncSendState(activeTab);
  }

  /**
   * Build the imperative collaborators over the DOM rest-tab.tsx just rendered.
   * Order matters: headersEditor and responseView are both reachable from the tab
   * strip's construction tail (writeUI, onActivate), so they come first.
   */
  function attach(els: RestElements) {
    headersEditor = createHeadersEditor({
      listEl: els.headersListEl,
      addBtn: els.addHeaderBtn,
      onChange: () => tabs.onActiveEdited(),
    });

    responseView = createResponseView({
      responseEl: els.responseEl,
      errorEl: els.errorEl,
      vscode,
    });

    tabs = createTabStrip({
      tabBarEl: els.tabBarEl,
      vscode,
      persistType: 'saveRestCallTabs',
      addTooltip: 'New request tab',
      newPayload: () => ({ method: 'GET', endpoint: '', body: '', headers: [] }),
      payloadOf: (record: Record<string, unknown>) => ({
        method: record.method || 'GET',
        endpoint: record.endpoint || '',
        body: record.body || '',
        headers: Array.isArray(record.headers) ? record.headers : [],
      }),
      // Blank header rows included: dropping them here would delete a half-typed
      // header the moment the user switched tabs (see headers-editor.getAllHeaders).
      readUI: () => ({
        method: state.method.value,
        endpoint: state.endpoint.value,
        body: state.body.value,
        headers: headersEditor.getAllHeaders(),
      }),
      writeUI: (tab: {
        method: string;
        endpoint: string;
        body: string;
        headers?: HeaderEntry[];
      }) => {
        state.method.value = tab.method;
        state.endpoint.value = tab.endpoint;
        state.body.value = tab.body;
        headersEditor.setHeaders(tab.headers || []);
      },
      baseNameFor: (tab: { endpoint: string; method: string }) =>
        endpointBaseName(tab.endpoint, tab.method),
      // An untouched tab: no endpoint to call and no body to keep.
      isPristine: (tab: { endpoint?: string; body?: string }) =>
        !(tab.endpoint || '').trim() && !(tab.body || '').trim(),
      onActivate: (tab) => {
        renderTabOutput(tab);
        syncSendState(tab);
      },
      onTabClosed: (tab) => stopRun(tab.opId),
    });

    history = createRestCallHistory({
      buttonEl: els.historyButtonEl,
      dropdownEl: els.historyDropdownEl,
      saveBtn: els.historySaveBtn,
      vscode,
      getCurrent,
      getDefaultName: () => tabs.getActive()?.name ?? '',
      // Its own tab (or a pristine active one), so a pick never destroys open work.
      onPick: (entry) =>
        tabs.openTab({
          payload: {
            method: entry.method,
            endpoint: entry.endpoint,
            body: entry.body,
            headers: entry.headers || [],
          },
          name: entry.name,
        }),
      onSaved: (name) => tabs.renameActiveAsSaved(name),
    });
  }

  /** The host reply handlers, registered by index.tsx once the tree is mounted. */
  const handlers = {
    restCallResult(msg: { data?: RestResponseData & { opId?: string } }) {
      const owner = ownerOf(msg);
      if (!owner) return;
      const { tab, opId } = owner;
      tabs.settleRun(tab, msg.data, null);
      // Record what was actually sent, not what the form holds now — the user may
      // have edited it, or switched to another tab entirely, while this was in flight.
      const run = pendingRuns.get(opId);
      pendingRuns.delete(opId);
      if (run) history.recordRun(run);
      if (tab !== tabs.getActive()) return;
      responseView.showResponse(msg.data as RestResponseData);
      syncSendState(tab);
    },
    restCallError(msg: { data?: { opId?: string; message: string } }) {
      const owner = ownerOf(msg);
      if (!owner) return;
      const { tab, opId } = owner;
      tabs.settleRun(tab, null, msg.data!.message);
      pendingRuns.delete(opId);
      if (tab !== tabs.getActive()) return;
      responseView.showError(msg.data!.message);
      syncSendState(tab);
    },
    restCallStateLoaded(msg: { data?: Record<string, unknown> }) {
      const loaded = msg.data || {};
      tabs.load(loaded);
      history.load(loaded);
    },
    restCallHistoryUpdated(msg: { data?: { history: RestHistoryEntry[] } }) {
      history.onHistoryUpdated(msg.data!.history);
    },
    restCallSavedRequestsUpdated(msg: { data?: { savedRequests: never[] } }) {
      history.onSavedUpdated(msg.data!.savedRequests);
    },
    cancelAllOperations: () => stopAllRuns(),
  };

  return {
    attach,
    handlers,
    send,
    cancelActiveRun,
    stopAllRuns,
    cloneActiveTab: () => tabs.cloneActive(),
    /** Fold a live-form edit into the active tab. Bound to every input. */
    onEdited: () => tabs.onActiveEdited(),
  };
}

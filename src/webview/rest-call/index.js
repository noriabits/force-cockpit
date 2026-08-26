// @ts-check
// REST tab — call arbitrary REST / Apex REST endpoints on the connected org.
// Mirrors the SOQL query editor module: a bar of request tabs over one shared
// editing surface (method + endpoint + body + headers), talking to the host via
// win.__onMessage / postMessage. Tabs persist through saveRestCallTabs and are
// restored by loadRestCallState. Bundled by esbuild into dist/webview/rest-call.js.
// Wires four focused sub-modules: the shared tab strip, headers-editor.js (custom
// headers), history.js (request history + saved/named requests), response-view.js
// (status/headers/body, incl. clickable record-Id links).

import { createTabStrip } from '../../features/shared/view/tab-strip';
import { createHeadersEditor } from './headers-editor';
import { createRestCallHistory } from './history';
import { createResponseView } from './response-view';
import { endpointBaseName } from './rest-tab-name';

const win = /** @type {any} */ (window);
const vscode = win.__vscode;

const tabBarEl = /** @type {HTMLElement} */ (document.getElementById('rest-tab-bar'));
const methodEl = /** @type {HTMLSelectElement} */ (document.getElementById('rest-method'));
const endpointEl = /** @type {HTMLInputElement} */ (document.getElementById('rest-endpoint'));
const bodyEl = /** @type {HTMLTextAreaElement} */ (document.getElementById('rest-body'));
const btnSend = /** @type {HTMLButtonElement} */ (document.getElementById('btn-rest-send'));
const btnClone = /** @type {HTMLButtonElement} */ (document.getElementById('btn-rest-clone'));
const responseEl = /** @type {HTMLElement} */ (document.getElementById('rest-response'));
const responseMetaEl = /** @type {HTMLElement} */ (document.getElementById('rest-response-meta'));
const responseBodyEl = /** @type {HTMLElement} */ (document.getElementById('rest-response-body'));
const responseHeadersListEl = /** @type {HTMLElement} */ (
  document.getElementById('rest-response-headers-list')
);
const btnHeadersToggle = /** @type {HTMLButtonElement} */ (
  document.getElementById('btn-rest-headers-toggle')
);
const btnOpenEditor = /** @type {HTMLButtonElement} */ (
  document.getElementById('btn-rest-open-editor')
);
const btnCopyOutput = /** @type {HTMLButtonElement} */ (
  document.getElementById('btn-rest-copy-output')
);
const errorEl = /** @type {HTMLElement} */ (document.getElementById('rest-error'));

const headersListEl = /** @type {HTMLElement} */ (document.getElementById('rest-headers-list'));
const btnAddHeader = /** @type {HTMLButtonElement} */ (
  document.getElementById('btn-rest-add-header')
);
const btnHistory = /** @type {HTMLButtonElement} */ (document.getElementById('btn-rest-history'));
const historyDropdownEl = /** @type {HTMLElement} */ (
  document.getElementById('rest-history-dropdown')
);
const btnSaveRequest = /** @type {HTMLButtonElement} */ (
  document.getElementById('btn-rest-save-request')
);

const headersEditor = createHeadersEditor({
  listEl: headersListEl,
  addBtn: btnAddHeader,
  onChange: () => tabs.onActiveEdited(),
});

const responseView = createResponseView({
  responseEl,
  errorEl,
  metaEl: responseMetaEl,
  bodyEl: responseBodyEl,
  headersToggleBtn: btnHeadersToggle,
  headersListEl: responseHeadersListEl,
  openEditorBtn: btnOpenEditor,
  copyBtn: btnCopyOutput,
  vscode,
  escapeHtml: win.__escapeHtml,
});

/** @returns {{ method: string, endpoint: string, body: string, headers: {key: string, value: string}[] }} */
function getCurrent() {
  return {
    method: methodEl.value,
    endpoint: endpointEl.value,
    body: bodyEl.value,
    headers: headersEditor.getHeaders(),
  };
}

// ── Response rendering ──────────────────────────────────────────────────────────
/** Paint whatever the given tab last produced — a response, an error, or nothing. */
function renderTabOutput(/** @type {any} */ tab) {
  if (tab && tab.results) responseView.showResponse(tab.results);
  else if (tab && tab.error) responseView.showError(tab.error);
  else responseView.hideResponse();
}

// ── Send button state ───────────────────────────────────────────────────────────
// Not win.__startAction: that binds one opId to one button for the life of the
// op, whereas Send is shared by every tab and has to be repainted from whichever
// tab is active. The spinner class and the cancel button are the same ones.
/** @type {HTMLButtonElement | null} */
let cancelBtn = null;

function paintSendState(/** @type {any} */ tab) {
  const running = !!(tab && tab.opId);
  btnSend.disabled = running;
  btnSend.classList.toggle('running', running);

  if (running && !cancelBtn) {
    cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn-ghost action-cancel-btn';
    cancelBtn.textContent = '✕ Cancel';
    cancelBtn.addEventListener('click', () => {
      const activeTab = tabs.getActive();
      stopRun(tabs.getActiveOpId());
      tabs.setActiveOpId(null);
      paintSendState(activeTab);
    });
    btnSend.parentElement?.insertBefore(cancelBtn, btnSend.nextSibling);
  } else if (!running && cancelBtn) {
    cancelBtn.remove();
    cancelBtn = null;
  }
}

// ── Tabs ────────────────────────────────────────────────────────────────────────
const tabs = createTabStrip({
  tabBarEl,
  vscode,
  persistType: 'saveRestCallTabs',
  addTooltip: 'New request tab',
  newPayload: () => ({ method: 'GET', endpoint: '', body: '', headers: [] }),
  payloadOf: (record) => ({
    method: record.method || 'GET',
    endpoint: record.endpoint || '',
    body: record.body || '',
    headers: Array.isArray(record.headers) ? record.headers : [],
  }),
  // Blank header rows included: dropping them here would delete a half-typed
  // header the moment the user switched tabs (see headers-editor.getAllHeaders).
  readUI: () => ({
    method: methodEl.value,
    endpoint: endpointEl.value,
    body: bodyEl.value,
    headers: headersEditor.getAllHeaders(),
  }),
  writeUI: (tab) => {
    methodEl.value = tab.method;
    endpointEl.value = tab.endpoint;
    bodyEl.value = tab.body;
    headersEditor.setHeaders(tab.headers || []);
  },
  baseNameFor: (tab) => endpointBaseName(tab.endpoint, tab.method),
  // An untouched tab: no endpoint to call and no body to keep.
  isPristine: (tab) => !(tab.endpoint || '').trim() && !(tab.body || '').trim(),
  onActivate: (tab) => {
    renderTabOutput(tab);
    paintSendState(tab);
  },
  onTabClosed: (tab) => stopRun(tab.opId),
});

// ── History ─────────────────────────────────────────────────────────────────────
const history = createRestCallHistory({
  buttonEl: btnHistory,
  dropdownEl: historyDropdownEl,
  saveBtn: btnSaveRequest,
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
});

// ── Run tracking ────────────────────────────────────────────────────────────────
let opSeq = 0;
/** Requests in flight, by opId — the record history is written from once one settles. */
const pendingRuns = new Map();

/** @param {string | null} opId */
function stopRun(opId) {
  if (!opId) return;
  pendingRuns.delete(opId);
  vscode.postMessage({ type: 'cancelOperation', opId });
  vscode.postMessage({ type: 'operationEnded', opId });
}

function stopAllRuns() {
  for (const opId of tabs.getRunningOpIds()) stopRun(opId);
  tabs.clearAllOpIds();
  paintSendState(tabs.getActive());
}

/**
 * The tab a reply belongs to, or null when it has none — closed, cancelled or
 * superseded — in which case the reply is dropped.
 * @param {any} msg
 */
function ownerOf(msg) {
  const opId = msg.data?.opId;
  const tab = tabs.findByOpId(opId);
  if (opId) vscode.postMessage({ type: 'operationEnded', opId });
  if (!tab) return null;
  return { tab, opId };
}

// ── Message handlers ────────────────────────────────────────────────────────────
win.__onMessage('restCallResult', (/** @type {any} */ msg) => {
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
  responseView.showResponse(msg.data);
  paintSendState(tab);
});

win.__onMessage('restCallError', (/** @type {any} */ msg) => {
  const owner = ownerOf(msg);
  if (!owner) return;
  const { tab, opId } = owner;
  tabs.settleRun(tab, null, msg.data.message);
  pendingRuns.delete(opId);
  if (tab !== tabs.getActive()) return;
  responseView.showError(msg.data.message);
  paintSendState(tab);
});

win.__onMessage('restCallStateLoaded', (/** @type {any} */ msg) => {
  const state = msg.data || {};
  tabs.load(state);
  history.load(state);
});

win.__onMessage('restCallHistoryUpdated', (/** @type {any} */ msg) => {
  history.onHistoryUpdated(msg.data.history);
});

win.__onMessage('restCallSavedRequestsUpdated', (/** @type {any} */ msg) => {
  history.onSavedUpdated(msg.data.savedRequests);
});

win.__onMessage('cancelAllOperations', () => stopAllRuns());

// A reply from the org that was connected when the request went out must never
// land in a tab now pointed at a different org. An org-to-org switch fires only
// the connect edge, so both are handled.
win.__registerFeature('rest-call', {
  onOrgConnected: () => stopAllRuns(),
  onOrgDisconnected: () => stopAllRuns(),
});

// ── Sending ─────────────────────────────────────────────────────────────────────
/** Verbs that mutate org data — gated behind sensitive-org confirmation. */
const DESTRUCTIVE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Send `request` on behalf of `tab`. Both are captured by the caller rather than
 * re-read here: the sensitive-org confirmation is asynchronous, so by the time
 * this runs the user may have edited the form or switched to another tab.
 * @param {any} tab @param {any} request
 */
function dispatchSend(tab, request) {
  const opId = 'rest-' + ++opSeq;
  if (tab === tabs.getActive()) responseView.hideResponse();
  tabs.settleRun(tab, null, null);
  pendingRuns.set(opId, request);
  tab.opId = opId;
  paintSendState(tabs.getActive());
  vscode.postMessage({ type: 'restCall', ...request, opId });
  // Lets the host count this as busy, so switching orgs mid-request warns first.
  vscode.postMessage({ type: 'operationStarted', opId });
}

btnSend.addEventListener('click', () => {
  // Fold the live form into the active tab first, so what is sent and what the
  // tab holds can never disagree.
  tabs.onActiveEdited();
  const tab = tabs.getActive();
  const request = getCurrent();
  request.endpoint = request.endpoint.trim();
  if (!request.endpoint) {
    responseView.showError('Enter an endpoint path.');
    return;
  }
  if (!win.__orgConnected) {
    responseView.showError('Not connected to any org.');
    return;
  }
  const send = () => dispatchSend(tab, request);
  // Destructive verbs on a sensitive org (production / protected sandbox) require
  // confirmation; __confirmIfSensitive no-ops straight to the callback otherwise.
  if (DESTRUCTIVE_METHODS.has((request.method || '').toUpperCase())) {
    win.__confirmIfSensitive(win.__currentOrg, 'Send this REST request?', send);
  } else {
    send();
  }
});

btnClone.addEventListener('click', () => tabs.cloneActive());

// ── Input handlers ──────────────────────────────────────────────────────────────
methodEl.addEventListener('change', () => tabs.onActiveEdited());
endpointEl.addEventListener('input', () => tabs.onActiveEdited());
bodyEl.addEventListener('input', () => tabs.onActiveEdited());

bodyEl.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    btnSend.click();
  }
});

// Load persisted tabs once the bundle is live.
vscode.postMessage({ type: 'loadRestCallState' });

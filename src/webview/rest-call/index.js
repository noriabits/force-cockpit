// @ts-check
// REST tab — call arbitrary REST / Apex REST endpoints on the connected org.
// Mirrors the Quick Query module: talks to the host via win.__onMessage / postMessage,
// persists the last { method, endpoint, body, headers } through saveRestCallState, and
// restores it on load via loadRestCallState. Bundled by esbuild into dist/webview/rest-call.js.
// Wires three focused sub-modules: headers-editor.js (custom headers), history.js
// (request history + saved/named requests), response-view.js (status/headers/body,
// incl. clickable record-Id links).

import { createHeadersEditor } from './headers-editor';
import { createRestCallHistory } from './history';
import { createResponseView } from './response-view';

const win = /** @type {any} */ (window);
const vscode = win.__vscode;

const methodEl = /** @type {HTMLSelectElement} */ (document.getElementById('rest-method'));
const endpointEl = /** @type {HTMLInputElement} */ (document.getElementById('rest-endpoint'));
const bodyEl = /** @type {HTMLTextAreaElement} */ (document.getElementById('rest-body'));
const btnSend = /** @type {HTMLButtonElement} */ (document.getElementById('btn-rest-send'));
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
  onChange: () => scheduleSave(),
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

const history = createRestCallHistory({
  buttonEl: btnHistory,
  dropdownEl: historyDropdownEl,
  saveBtn: btnSaveRequest,
  vscode,
  getCurrent,
  onPick: (entry) => {
    methodEl.value = entry.method;
    endpointEl.value = entry.endpoint;
    bodyEl.value = entry.body;
    headersEditor.setHeaders(entry.headers || []);
    scheduleSave();
  },
});

// ── Persistence (debounced) ─────────────────────────────────────────────────────
/** @type {ReturnType<typeof setTimeout> | undefined} */
let saveTimer;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const cur = getCurrent();
    vscode.postMessage({ type: 'saveRestCallState', ...cur });
  }, 300);
}

// ── Message handlers ────────────────────────────────────────────────────────────
function stopSending() {
  btnSend.disabled = false;
  btnSend.classList.remove('running');
}

win.__onMessage('restCallResult', (/** @type {any} */ msg) => {
  stopSending();
  responseView.showResponse(msg.data);
  history.recordRun(getCurrent());
});

win.__onMessage('restCallError', (/** @type {any} */ msg) => {
  stopSending();
  responseView.showError(msg.data.message);
});

win.__onMessage('restCallStateLoaded', (/** @type {any} */ msg) => {
  const cfg = msg.data || {};
  if (cfg.method) methodEl.value = cfg.method;
  endpointEl.value = cfg.endpoint || '';
  bodyEl.value = cfg.body || '';
  headersEditor.setHeaders(cfg.headers || []);
  history.load(cfg);
});

win.__onMessage('restCallHistoryUpdated', (/** @type {any} */ msg) => {
  history.onHistoryUpdated(msg.data.history);
});

win.__onMessage('restCallSavedRequestsUpdated', (/** @type {any} */ msg) => {
  history.onSavedUpdated(msg.data.savedRequests);
});

// ── Input handlers ──────────────────────────────────────────────────────────────
/** Verbs that mutate org data — gated behind sensitive-org confirmation. */
const DESTRUCTIVE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** @param {string} endpoint */
function dispatchSend(endpoint) {
  responseView.hideResponse();
  btnSend.disabled = true;
  btnSend.classList.add('running');
  const cur = getCurrent();
  vscode.postMessage({ type: 'restCall', ...cur, endpoint });
}

btnSend.addEventListener('click', () => {
  const endpoint = endpointEl.value.trim();
  if (!endpoint) {
    responseView.showError('Enter an endpoint path.');
    return;
  }
  if (!win.__orgConnected) {
    responseView.showError('Not connected to any org.');
    return;
  }
  const send = () => dispatchSend(endpoint);
  // Destructive verbs on a sensitive org (production / protected sandbox) require
  // confirmation; __confirmIfSensitive no-ops straight to the callback otherwise.
  if (DESTRUCTIVE_METHODS.has((methodEl.value || '').toUpperCase())) {
    win.__confirmIfSensitive(win.__currentOrg, 'Send this REST request?', send);
  } else {
    send();
  }
});

methodEl.addEventListener('change', scheduleSave);
endpointEl.addEventListener('input', scheduleSave);
bodyEl.addEventListener('input', scheduleSave);

bodyEl.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    btnSend.click();
  }
});

// Load persisted config once the bundle is live.
vscode.postMessage({ type: 'loadRestCallState' });

// @ts-check
// REST tab — call arbitrary REST / Apex REST endpoints on the connected org.
// Mirrors the Quick Query module: talks to the host via win.__onMessage / postMessage,
// persists the last { method, endpoint, body } through saveRestCallState, and restores
// it on load via loadRestCallState. Bundled by esbuild into dist/webview/rest-call.js.

const win = /** @type {any} */ (window);
const vscode = win.__vscode;

const methodEl = /** @type {HTMLSelectElement} */ (document.getElementById('rest-method'));
const endpointEl = /** @type {HTMLInputElement} */ (document.getElementById('rest-endpoint'));
const bodyEl = /** @type {HTMLTextAreaElement} */ (document.getElementById('rest-body'));
const btnSend = /** @type {HTMLButtonElement} */ (document.getElementById('btn-rest-send'));
const responseEl = /** @type {HTMLElement} */ (document.getElementById('rest-response'));
const responseMetaEl = /** @type {HTMLElement} */ (document.getElementById('rest-response-meta'));
const responseBodyEl = /** @type {HTMLElement} */ (document.getElementById('rest-response-body'));
const errorEl = /** @type {HTMLElement} */ (document.getElementById('rest-error'));

// ── Response / error display ──────────────────────────────────────────────────
function hideResponse() {
  responseEl.style.display = 'none';
  errorEl.style.display = 'none';
}

/** @param {unknown} body */
function showResponse(body) {
  errorEl.style.display = 'none';
  responseMetaEl.textContent = 'Response';
  responseBodyEl.textContent =
    body === undefined || body === '' ? '(empty response)' : formatBody(body);
  responseEl.style.display = '';
}

/** @param {string} message */
function showError(message) {
  responseEl.style.display = 'none';
  errorEl.textContent = message;
  errorEl.style.display = '';
}

/** Pretty-print objects; show strings/other primitives as-is. */
function formatBody(/** @type {unknown} */ body) {
  if (typeof body === 'string') {
    // The host may hand back a raw JSON string — pretty-print it when parseable.
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      return body;
    }
  }
  try {
    return JSON.stringify(body, null, 2);
  } catch {
    return String(body);
  }
}

// ── Persistence (debounced) ─────────────────────────────────────────────────────
/** @type {ReturnType<typeof setTimeout> | undefined} */
let saveTimer;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    vscode.postMessage({
      type: 'saveRestCallState',
      method: methodEl.value,
      endpoint: endpointEl.value,
      body: bodyEl.value,
    });
  }, 300);
}

// ── Message handlers ────────────────────────────────────────────────────────────
function stopSending() {
  btnSend.disabled = false;
  btnSend.classList.remove('running');
}

win.__onMessage('restCallResult', (/** @type {any} */ msg) => {
  stopSending();
  showResponse(msg.data.body);
});

win.__onMessage('restCallError', (/** @type {any} */ msg) => {
  stopSending();
  showError(msg.data.message);
});

win.__onMessage('restCallStateLoaded', (/** @type {any} */ msg) => {
  const cfg = msg.data || {};
  if (cfg.method) methodEl.value = cfg.method;
  endpointEl.value = cfg.endpoint || '';
  bodyEl.value = cfg.body || '';
});

// ── Input handlers ──────────────────────────────────────────────────────────────
/** Verbs that mutate org data — gated behind sensitive-org confirmation. */
const DESTRUCTIVE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** @param {string} endpoint */
function dispatchSend(endpoint) {
  hideResponse();
  btnSend.disabled = true;
  btnSend.classList.add('running');
  vscode.postMessage({
    type: 'restCall',
    method: methodEl.value,
    endpoint,
    body: bodyEl.value,
  });
}

btnSend.addEventListener('click', () => {
  const endpoint = endpointEl.value.trim();
  if (!endpoint) {
    showError('Enter an endpoint path.');
    return;
  }
  if (!win.__orgConnected) {
    showError('Not connected to any org.');
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

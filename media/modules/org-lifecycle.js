// @ts-check
// Org connection lifecycle: connecting / connected / disconnected states.
// Drives the Overview tab's empty/connecting/connected content, status dot + label,
// org info card, sensitive-org banner, and the Open-in-Browser button.
// Broadcasts onOrgConnected / onOrgDisconnected to registered feature handlers.

(function () {
  const win = /** @type {any} */ (window);
  const vscode = win.__vscode;

  const emptyState = /** @type {HTMLElement} */ (document.getElementById('empty-state'));
  const connectingState = /** @type {HTMLElement} */ (document.getElementById('connecting-state'));
  const connectingLabel = /** @type {HTMLElement} */ (document.getElementById('connecting-label'));
  const connectedContent = /** @type {HTMLElement} */ (
    document.getElementById('connected-content')
  );
  const statusDot = /** @type {HTMLElement} */ (document.getElementById('status-dot'));
  const statusLabel = /** @type {HTMLElement} */ (document.getElementById('status-label'));

  const orgAlias = /** @type {HTMLElement} */ (document.getElementById('org-alias'));
  const orgUsername = /** @type {HTMLElement} */ (document.getElementById('org-username'));
  const orgId = /** @type {HTMLElement} */ (document.getElementById('org-id'));
  const orgInstance = /** @type {HTMLElement} */ (document.getElementById('org-instance'));
  const productionWarning = /** @type {HTMLElement} */ (
    document.getElementById('production-warning')
  );

  const btnOpenBrowser = /** @type {HTMLButtonElement} */ (
    document.getElementById('btn-open-browser')
  );
  const storageCard = /** @type {HTMLElement} */ (document.getElementById('storage-card'));

  // Connection state — mirrored on window for other modules (e.g. query-editor) to read.
  win.__orgConnected = false;
  win.__currentOrg = null;

  /** @param {string} orgName */
  function setConnecting(orgName) {
    win.__orgConnected = false;
    win.__currentOrg = null;
    statusDot.className = 'status-dot connecting';
    statusLabel.textContent = 'Connecting…';
    emptyState.style.display = 'none';
    connectingState.style.display = '';
    connectingLabel.textContent = `Connecting to "${orgName}"…`;
    connectedContent.style.display = 'none';
    productionWarning.style.display = 'none';
  }

  /** @param {Record<string, any>} org */
  function setConnected(org) {
    win.__orgConnected = true;
    win.__currentOrg = org;
    const isProduction = !org.sandboxName;
    statusDot.className = `status-dot connected${isProduction ? ' production' : ''}`;
    const name = org.alias || org.username;
    statusLabel.textContent = name;
    orgAlias.textContent = org.alias || '—';
    orgUsername.textContent = org.username || '—';
    orgId.textContent = org.orgId || '—';
    orgInstance.textContent = org.instanceUrl || '—';

    emptyState.style.display = 'none';
    connectingState.style.display = 'none';
    connectedContent.style.display = '';
    const isSensitiveOrg = isProduction || org.isProtectedOrg;
    productionWarning.textContent = isProduction
      ? '⚠️ Production org — be careful with the actions you execute.'
      : '🛡️ Protected sandbox — be careful with the actions you execute.';
    productionWarning.style.display = isSensitiveOrg ? '' : 'none';
  }

  function setDisconnected() {
    win.__orgConnected = false;
    win.__currentOrg = null;
    statusDot.className = 'status-dot disconnected';
    statusLabel.textContent = 'Not connected';
    emptyState.style.display = '';
    connectingState.style.display = 'none';
    connectedContent.style.display = 'none';
    productionWarning.style.display = 'none';
    storageCard.style.display = 'none';
    win.__clearQueryResults?.();
  }

  // ── Message handlers ────────────────────────────────────────────────────
  win.__onMessage('orgConnecting', (/** @type {any} */ msg) => setConnecting(msg.orgName));

  win.__onMessage('orgConnected', (/** @type {any} */ msg) => {
    setConnected(msg.data);
    Object.values(win.__featureHandlers).forEach(
      (/** @type {any} */ h) => h.onOrgConnected && h.onOrgConnected(msg.data),
    );
  });

  win.__onMessage('orgDisconnected', () => {
    setDisconnected();
    Object.values(win.__featureHandlers).forEach(
      (/** @type {any} */ h) => h.onOrgDisconnected && h.onOrgDisconnected(),
    );
  });

  // ── Open in Browser button ──────────────────────────────────────────────
  btnOpenBrowser.addEventListener('click', () => {
    btnOpenBrowser.disabled = true;
    btnOpenBrowser.classList.add('running');
    vscode.postMessage({ type: 'openInBrowser' });
  });

  win.__onMessage('openInBrowserDone', () => {
    btnOpenBrowser.disabled = false;
    btnOpenBrowser.classList.remove('running');
  });
})();

// @ts-check
// Org connection lifecycle: connecting / connected / disconnected states.
// Drives the Overview tab's empty/connecting/connected content, status dot + label,
// org info card, sensitive-org banner, and the Open-in-Browser button.
// Broadcasts onOrgConnected / onOrgDisconnected to registered feature handlers.
// onOrgConnected fires once per real connection (including a reconnect to the
// same org) — never merely because the panel regained visibility.

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
  const orgInstanceName = /** @type {HTMLElement} */ (document.getElementById('org-instance-name'));
  const orgRelease = /** @type {HTMLElement} */ (document.getElementById('org-release'));
  const productionWarning = /** @type {HTMLElement} */ (
    document.getElementById('production-warning')
  );

  const btnOpenBrowser = /** @type {HTMLButtonElement} */ (
    document.getElementById('btn-open-browser')
  );
  const btnRefreshOrg = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('btn-refresh-org')
  );
  const btnRefreshOrgEmpty = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('btn-refresh-org-empty')
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
    statusLabel.classList.add('status-label--clickable');
    statusLabel.tabIndex = 0;
    win.__setTooltip?.(statusLabel, 'Open org in browser');
    orgAlias.textContent = org.alias || '—';
    orgUsername.textContent = org.username || '—';
    orgId.textContent = org.orgId || '—';
    orgInstance.textContent = org.instanceUrl || '—';
    const instanceName = org.instanceName ? win.__escapeHtml(org.instanceName) : '';
    const statusUrl = `https://status.salesforce.com/instances/${encodeURIComponent(org.instanceName || '')}`;
    orgInstanceName.innerHTML = instanceName
      ? `<a href="#" class="org-instance-link" data-url="${win.__escapeHtml(statusUrl)}">${instanceName} ↗</a>`
      : '—';
    orgRelease.textContent = '—';

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
    statusLabel.classList.remove('status-label--clickable');
    statusLabel.tabIndex = -1;
    emptyState.style.display = '';
    connectingState.style.display = 'none';
    connectedContent.style.display = 'none';
    productionWarning.style.display = 'none';
    storageCard.style.display = 'none';
    win.__clearQueryResults?.();
  }

  // ── Message handlers ────────────────────────────────────────────────────
  // `?.` because this is the untrusted side of the boundary — the protocol says
  // `data` is always sent, but nothing here can check that.
  win.__onMessage('orgConnecting', (/** @type {any} */ msg) => setConnecting(msg.data?.orgName));

  // The host re-sends `orgConnected` every time the panel regains visibility,
  // just to refresh the header. Features must only hear about a *new*
  // connection — otherwise a tab switch wipes their state (a chat, an in-flight
  // run) — so their hook is gated on the host's per-connection epoch changing.
  // null = no connection seen yet (fresh webview, or after a disconnect).
  /** @type {number | null} */
  let lastConnectionEpoch = null;

  win.__onMessage('orgConnected', (/** @type {any} */ msg) => {
    setConnected(msg.data);
    const epoch = msg.data?.connectionEpoch ?? null;
    if (epoch !== null && epoch === lastConnectionEpoch) return;
    lastConnectionEpoch = epoch;
    Object.values(win.__featureHandlers).forEach(
      (/** @type {any} */ h) => h.onOrgConnected && h.onOrgConnected(msg.data),
    );
  });

  win.__onMessage('releaseInfo', (/** @type {any} */ msg) => {
    orgRelease.textContent = `${msg.data.label} (v${msg.data.apiVersion})`;
  });

  win.__onMessage('orgDisconnected', () => {
    lastConnectionEpoch = null;
    setDisconnected();
    Object.values(win.__featureHandlers).forEach(
      (/** @type {any} */ h) => h.onOrgDisconnected && h.onOrgDisconnected(),
    );
  });

  // ── Instance status page link ───────────────────────────────────────────
  orgInstanceName.addEventListener('click', (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    if (target.tagName === 'A' && target.classList.contains('org-instance-link')) {
      event.preventDefault();
      const url = target.getAttribute('data-url');
      if (url) vscode.postMessage({ type: 'openExternalUrl', url });
    }
  });

  // ── Open in Browser (button + clickable status label share this) ────────
  function openOrgInBrowser() {
    if (btnOpenBrowser.disabled) return;
    btnOpenBrowser.disabled = true;
    btnOpenBrowser.classList.add('running');
    vscode.postMessage({ type: 'openInBrowser' });
  }

  btnOpenBrowser.addEventListener('click', openOrgInBrowser);

  statusLabel.addEventListener('click', () => {
    if (win.__orgConnected) openOrgInBrowser();
  });
  statusLabel.addEventListener('keydown', (event) => {
    if (win.__orgConnected && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      openOrgInBrowser();
    }
  });

  win.__onMessage('openInBrowserDone', () => {
    btnOpenBrowser.disabled = false;
    btnOpenBrowser.classList.remove('running');
  });

  // ── Refresh Org buttons (header + empty state) ──────────────────────────
  // No `@type {any}` on the parameter: that annotation is what defeated TS's
  // inferred type predicate, so `.filter` returned `(HTMLButtonElement | null)[]`
  // and the declared type above was a lie the checker rejected. Typed as written,
  // TS narrows the result to HTMLButtonElement[] on its own.
  const refreshButtons = [btnRefreshOrg, btnRefreshOrgEmpty].filter((b) => b !== null);

  refreshButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      refreshButtons.forEach((b) => {
        b.disabled = true;
        b.classList.add('running');
      });
      vscode.postMessage({ type: 'refreshOrg' });
    });
  });

  win.__onMessage('refreshOrgDone', () => {
    refreshButtons.forEach((b) => {
      b.disabled = false;
      b.classList.remove('running');
    });
  });
})();

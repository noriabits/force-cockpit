// @ts-check
// Force Cockpit — Webview Script (core)
// Runs inside the VSCode webview. Communicates with the extension host via postMessage.
// Feature-specific logic lives in src/features/{tab}/{feature}/view.js files.

(function () {
  const win = /** @type {any} */ (window);

  // VSCode API — available only inside VSCode webviews. Called exactly once.
  // @ts-ignore — acquireVsCodeApi is injected by the VSCode webview runtime
  const vscode = acquireVsCodeApi();

  // Expose for feature scripts (they must NOT call acquireVsCodeApi() themselves).
  Object.defineProperty(window, '__vscode', { value: vscode, writable: false });

  // Feature message bus. Feature scripts register via window.__registerFeature().
  win.__featureHandlers = {};
  win.__registerFeature = function (/** @type {string} */ id, /** @type {any} */ handler) {
    win.__featureHandlers[id] = handler;
  };

  /** Shared HTML escaper for all webview feature scripts. Returns '' for null/undefined. */
  win.__escapeHtml = function (/** @type {unknown} */ str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  };

  // ── Sensitive-org confirmation utility ─────────────────────────────────────
  // window.confirm() is blocked in VSCode webviews. Features call this instead
  // to show a native VSCode modal dialog via the extension host.
  /** @type {Map<string, { onConfirmed: () => void; onCancelled?: () => void }>} */
  const _pendingConfirmations = new Map();
  let _confirmSeq = 0;

  /**
   * If `orgData` represents a sensitive org (production or protected sandbox),
   * shows a VSCode modal confirmation before calling `onConfirmed`. Otherwise
   * calls `onConfirmed` immediately.
   * @param {any} orgData
   * @param {string} actionLabel  - e.g. "Execute this script?"
   * @param {() => void} onConfirmed
   * @param {(() => void) | undefined} [onCancelled]
   */
  win.__confirmIfSensitive = function (orgData, actionLabel, onConfirmed, onCancelled) {
    const isSensitive = (orgData && !orgData.sandboxName) || !!orgData?.isProtectedOrg;
    if (!isSensitive) {
      onConfirmed();
      return;
    }
    const orgLabel = !orgData.sandboxName ? 'a Production org' : 'a protected sandbox';
    const requestId = 'confirm-' + ++_confirmSeq;
    _pendingConfirmations.set(requestId, { onConfirmed, onCancelled });
    vscode.postMessage({
      type: 'confirmAction',
      requestId,
      prompt: `⚠️ You are connected to ${orgLabel}. ${actionLabel}`,
    });
  };

  // ── Generic action tracking ────────────────────────────────────────────────
  /** @type {Map<string, { btn: HTMLButtonElement, cancelBtn: HTMLButtonElement, onCancel: () => void }>} */
  const _activeOps = new Map();
  /** @type {Set<string>} opIds whose late results should be silently dropped */
  const _cancelledOps = new Set();
  let _opSeq = 0;

  /**
   * Start tracking an in-progress action. Disables `btn`, adds a CSS spinner,
   * injects a "✕ Cancel" button beside it, and posts `operationStarted`.
   * @param {HTMLButtonElement} btn
   * @param {() => void} onCancel
   * @returns {string} opId
   */
  win.__startAction = function (btn, onCancel) {
    const opId = 'op-' + ++_opSeq;

    btn.disabled = true;
    btn.classList.add('running');

    const cancelBtn = /** @type {HTMLButtonElement} */ (document.createElement('button'));
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn-ghost action-cancel-btn';
    cancelBtn.textContent = '✕ Cancel';
    cancelBtn.addEventListener(
      'click',
      () => {
        _endActionById(opId);
        _cancelledOps.add(opId);
        onCancel();
      },
      { once: true },
    );

    btn.parentElement?.insertBefore(cancelBtn, btn.nextSibling);
    _activeOps.set(opId, { btn, cancelBtn, onCancel });
    vscode.postMessage({ type: 'operationStarted', opId, count: _activeOps.size });
    return opId;
  };

  /**
   * End an in-progress action. Re-enables `btn`, removes spinner and Cancel button.
   * Safe to call with an already-ended or unknown opId (no-op).
   * @param {string | null | undefined} opId
   */
  win.__endAction = function (opId) {
    if (opId) _endActionById(opId);
  };

  /** @param {string} opId */
  function _endActionById(opId) {
    const op = _activeOps.get(opId);
    if (!op) return;
    _activeOps.delete(opId);
    op.btn.classList.remove('running');
    op.btn.disabled = false;
    op.cancelBtn.remove();
    vscode.postMessage({ type: 'operationEnded', opId, count: _activeOps.size });
  }

  // ── DOM refs ──────────────────────────────────────────────────────────────
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
  const btnOpenBrowser = /** @type {HTMLButtonElement} */ (
    document.getElementById('btn-open-browser')
  );

  const storageCard = /** @type {HTMLElement} */ (document.getElementById('storage-card'));
  const storageDataValue = /** @type {HTMLElement} */ (
    document.getElementById('storage-data-value')
  );
  const storageDataBar = /** @type {HTMLElement} */ (document.getElementById('storage-data-bar'));
  const storageFileValue = /** @type {HTMLElement} */ (
    document.getElementById('storage-file-value')
  );
  const storageFileBar = /** @type {HTMLElement} */ (document.getElementById('storage-file-bar'));
  const soqlInput = /** @type {HTMLTextAreaElement} */ (document.getElementById('soql-input'));
  const btnRunQuery = /** @type {HTMLButtonElement} */ (document.getElementById('btn-run-query'));
  const btnClearQuery = /** @type {HTMLButtonElement} */ (
    document.getElementById('btn-clear-query')
  );
  const queryHint = /** @type {HTMLElement} */ (document.getElementById('query-hint'));
  const queryResults = /** @type {HTMLElement} */ (document.getElementById('query-results'));
  const resultsMeta = /** @type {HTMLElement} */ (document.getElementById('results-meta'));
  const resultsThead = /** @type {HTMLElement} */ (document.getElementById('results-thead'));
  const resultsTbody = /** @type {HTMLElement} */ (document.getElementById('results-tbody'));
  const queryError = /** @type {HTMLElement} */ (document.getElementById('query-error'));
  const productionWarning = /** @type {HTMLElement} */ (
    document.getElementById('production-warning')
  );

  // ── State ─────────────────────────────────────────────────────────────────
  let connected = false;

  // ── Helpers ───────────────────────────────────────────────────────────────
  /** @param {string} orgName */
  function setConnecting(orgName) {
    connected = false;
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
    connected = true;
    statusDot.className = 'status-dot connected';
    const name = org.alias || org.username;
    statusLabel.textContent = name;
    orgAlias.textContent = org.alias || '—';
    orgUsername.textContent = org.username || '—';
    orgId.textContent = org.orgId || '—';
    orgInstance.textContent = org.instanceUrl || '—';

    emptyState.style.display = 'none';
    connectingState.style.display = 'none';
    connectedContent.style.display = '';
    const isProduction = !org.sandboxName;
    const isSensitiveOrg = isProduction || org.isProtectedOrg;
    productionWarning.textContent = isProduction
      ? '⚠️ Production org — be careful with the actions you execute.'
      : '🛡️ Protected sandbox — be careful with the actions you execute.';
    productionWarning.style.display = isSensitiveOrg ? '' : 'none';
  }

  function setDisconnected() {
    connected = false;
    statusDot.className = 'status-dot disconnected';
    statusLabel.textContent = 'Not connected';
    emptyState.style.display = '';
    connectingState.style.display = 'none';
    connectedContent.style.display = 'none';
    productionWarning.style.display = 'none';
    storageCard.style.display = 'none';
    clearResults();
  }

  /**
   * Format a MB value: show as KB when under 1 MB, otherwise MB.
   * @param {number} mb
   * @returns {string}
   */
  function formatStorageMB(mb) {
    if (mb < 1 && mb > 0) {
      return Math.round(mb * 1024) + ' KB';
    }
    return mb + ' MB';
  }

  /**
   * Render storage usage bars from limits data.
   * @param {{ DataStorageMB: { Max: number, Remaining: number }, FileStorageMB: { Max: number, Remaining: number } }} limits
   */
  function renderStorage(limits) {
    const data = limits.DataStorageMB;
    const file = limits.FileStorageMB;
    const dataUsed = data.Max - data.Remaining;
    const fileUsed = file.Max - file.Remaining;
    const dataPct = data.Max > 0 ? Math.round((dataUsed / data.Max) * 100) : 0;
    const filePct = file.Max > 0 ? Math.round((fileUsed / file.Max) * 100) : 0;

    storageDataValue.textContent =
      formatStorageMB(dataUsed) + ' / ' + formatStorageMB(data.Max) + ' (' + dataPct + '%)';
    storageDataBar.style.width = (dataUsed > 0 ? Math.max(dataPct, 1) : 0) + '%';
    storageDataBar.classList.toggle('storage-bar-warn', dataPct >= 75 && dataPct < 90);
    storageDataBar.classList.toggle('storage-bar-critical', dataPct >= 90);

    storageFileValue.textContent =
      formatStorageMB(fileUsed) + ' / ' + formatStorageMB(file.Max) + ' (' + filePct + '%)';
    storageFileBar.style.width = (fileUsed > 0 ? Math.max(filePct, 1) : 0) + '%';
    storageFileBar.classList.toggle('storage-bar-warn', filePct >= 75 && filePct < 90);
    storageFileBar.classList.toggle('storage-bar-critical', filePct >= 90);

    storageCard.style.display = '';
  }

  function clearResults() {
    queryResults.style.display = 'none';
    queryError.style.display = 'none';
    resultsThead.innerHTML = '';
    resultsTbody.innerHTML = '';
    resultsMeta.textContent = '';
  }

  /** @param {any} str @returns {string} */
  function escapeHtml(str) {
    if (str == null) return '<em style="opacity:0.5">null</em>';
    return win.__escapeHtml(str);
  }

  /** @param {{ records: any[], totalSize: number }} data */
  function renderQueryResults(data) {
    clearResults();
    queryError.style.display = 'none';

    const { records, totalSize } = data;
    if (!records || records.length === 0) {
      resultsMeta.textContent = 'Query returned 0 records.';
      queryResults.style.display = '';
      return;
    }

    resultsMeta.textContent = `${totalSize} record${totalSize !== 1 ? 's' : ''} (showing ${records.length})`;

    // Collect column names (excluding 'attributes')
    const cols = Object.keys(records[0]).filter((k) => k !== 'attributes');

    // Header
    const tr = document.createElement('tr');
    for (const col of cols) {
      const th = document.createElement('th');
      th.textContent = col;
      tr.appendChild(th);
    }
    resultsThead.appendChild(tr);

    // Rows
    for (const record of records) {
      const row = document.createElement('tr');
      for (const col of cols) {
        const td = document.createElement('td');
        const val = record[col];
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          // Nested object (e.g. related record) — show JSON
          td.innerHTML = `<code>${escapeHtml(JSON.stringify(val))}</code>`;
        } else {
          td.innerHTML = escapeHtml(val);
        }
        row.appendChild(td);
      }
      resultsTbody.appendChild(row);
    }

    queryResults.style.display = '';
  }

  // ── Message handler (from extension host) ─────────────────────────────────
  window.addEventListener('message', (event) => {
    const message = event.data;

    // Drop late results from operations the user already cancelled
    if (message.opId && _cancelledOps.has(message.opId)) {
      _cancelledOps.delete(message.opId);
      return;
    }

    switch (message.type) {
      case 'orgConnecting':
        setConnecting(message.orgName);
        break;
      case 'orgConnected':
        setConnected(message.data);
        Object.values(win.__featureHandlers).forEach(
          (h) => h.onOrgConnected && h.onOrgConnected(message.data),
        );
        break;
      case 'orgDisconnected':
        setDisconnected();
        Object.values(win.__featureHandlers).forEach(
          (h) => h.onOrgDisconnected && h.onOrgDisconnected(),
        );
        break;
      case 'storageLimits':
        renderStorage(message.data);
        break;
      case 'queryResult':
        btnRunQuery.disabled = false;
        queryHint.textContent = '';
        renderQueryResults(message.data);
        break;
      case 'queryError':
        btnRunQuery.disabled = false;
        queryHint.textContent = '';
        queryResults.style.display = 'none';
        queryError.textContent = message.data.message;
        queryError.style.display = '';
        break;
      case 'openInBrowserDone':
        btnOpenBrowser.disabled = false;
        btnOpenBrowser.classList.remove('running');
        break;
      case 'operationStarted':
      case 'operationEnded':
        break; // extension host uses these for busy tracking; no webview action needed
      case 'cancelAllOperations':
        for (const [opId, op] of _activeOps) {
          _cancelledOps.add(opId);
          op.cancelBtn.remove();
          op.btn.classList.remove('running');
          op.btn.disabled = false;
          op.onCancel();
        }
        _activeOps.clear();
        vscode.postMessage({ type: 'operationEnded', count: 0 });
        break;
      case 'confirmActionResult': {
        const { confirmed, requestId } = message.data ?? {};
        const pending = requestId && _pendingConfirmations.get(requestId);
        if (pending) {
          _pendingConfirmations.delete(requestId);
          if (confirmed) pending.onConfirmed();
          else if (pending.onCancelled) pending.onCancelled();
        }
        break;
      }
      default:
        Object.values(win.__featureHandlers).forEach((h) => h.onMessage && h.onMessage(message));
        break;
    }
  });

  // ── Button handlers ───────────────────────────────────────────────────────
  btnOpenBrowser.addEventListener('click', () => {
    btnOpenBrowser.disabled = true;
    btnOpenBrowser.classList.add('running');
    vscode.postMessage({ type: 'openInBrowser' });
  });

  btnRunQuery.addEventListener('click', () => {
    const soql = soqlInput.value.trim();
    if (!soql) return;
    if (!connected) {
      queryError.textContent = 'Not connected to any org.';
      queryError.style.display = '';
      return;
    }

    clearResults();
    btnRunQuery.disabled = true;
    queryHint.textContent = 'Running…';
    vscode.postMessage({ type: 'query', soql });
  });

  btnClearQuery.addEventListener('click', () => {
    soqlInput.value = '';
    clearResults();
  });

  // Run query on Cmd/Ctrl+Enter inside the textarea
  soqlInput.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      btnRunQuery.click();
    }
  });

  // ── Accordion toggle ───────────────────────────────────────────────────────
  // Feature HTML is injected server-side before the webview renders, so all
  // accordion triggers are already in the DOM when this script runs.
  document.querySelectorAll('.accordion-trigger').forEach((trigger) => {
    trigger.addEventListener('click', () => {
      const accordion = trigger.closest('.accordion');
      if (accordion) {
        accordion.classList.toggle('open');
        trigger.setAttribute(
          'aria-expanded',
          accordion.classList.contains('open') ? 'true' : 'false',
        );
      }
    });
  });

  // ── Feature filter ──────────────────────────────────────────────────────
  document.querySelectorAll('.feature-filter-input').forEach((input) => {
    // Built-in sub-tab has its own combined text+category filter below
    if (input.hasAttribute('data-no-generic-filter')) return;

    const tabContent = /** @type {HTMLElement} */ (
      input.closest('.utils-sub-tab-panel') || input.closest('.tab-content')
    );
    if (!tabContent) return;

    // Create a "no results" message (hidden by default via CSS)
    const noResults = document.createElement('div');
    noResults.className = 'feature-no-results';
    noResults.textContent = 'No matching features found.';
    tabContent.appendChild(noResults);

    input.addEventListener('input', () => {
      const query = /** @type {HTMLInputElement} */ (input).value.toLowerCase().trim();
      const sections = tabContent.querySelectorAll('.accordion, .card:not(:first-of-type)');
      let visibleCount = 0;

      sections.forEach((section) => {
        // Skip the filter container's parent card (tab description card)
        if (section.closest('.feature-filter')) return;

        const text = (section.textContent || '').toLowerCase();
        const matches = !query || text.includes(query);
        /** @type {HTMLElement} */ (section).style.display = matches ? '' : 'none';
        if (matches) visibleCount++;
      });

      noResults.style.display = visibleCount === 0 && query ? 'block' : 'none';
    });
  });

  // ── Paste-from-clipboard buttons ────────────────────────────────────────
  document.addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement} */ (e.target).closest('.paste-btn');
    if (!btn) return;
    const input = /** @type {HTMLInputElement | HTMLTextAreaElement | null} */ (
      btn.previousElementSibling
    );
    if (!input || (input.tagName !== 'INPUT' && input.tagName !== 'TEXTAREA')) return;
    navigator.clipboard
      .readText()
      .then((text) => {
        input.value = text.trim();
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      })
      .catch(() => {});
  });

  // ── Built-in utils: combined text + category filter ─────────────────────
  (function () {
    const panel = /** @type {HTMLElement} */ (document.getElementById('utils-sub-tab-built-in'));
    const searchInput = /** @type {HTMLInputElement} */ (
      document.getElementById('utils-builtin-search')
    );
    const pillsContainer = /** @type {HTMLElement} */ (
      document.getElementById('utils-builtin-pills')
    );
    if (!panel || !searchInput || !pillsContainer) return;

    let activeCategory = 'all';

    const noResults = document.createElement('div');
    noResults.className = 'feature-no-results';
    noResults.textContent = 'No matching features found.';
    panel.appendChild(noResults);

    function applyFilters() {
      const query = searchInput.value.toLowerCase().trim();
      const sections = panel.querySelectorAll('.accordion');
      let visible = 0;

      sections.forEach((el) => {
        const section = /** @type {HTMLElement} */ (el);
        const category = section.getAttribute('data-category') ?? '';
        const categoryMatch = activeCategory === 'all' || category === activeCategory;
        const textMatch = !query || (section.textContent || '').toLowerCase().includes(query);
        const show = categoryMatch && textMatch;
        section.style.display = show ? '' : 'none';
        if (show) visible++;
      });

      noResults.style.display = visible === 0 ? 'block' : 'none';
    }

    /**
     * @param {string} category
     * @param {HTMLButtonElement} activePill
     */
    function setActiveCategory(category, activePill) {
      activeCategory = category;
      pillsContainer.querySelectorAll('.category-pill').forEach((p) => {
        p.classList.toggle('active', p === activePill);
      });
      applyFilters();
    }

    // Build pills from data-category attributes on accordion elements
    const accordions = panel.querySelectorAll('.accordion[data-category]');
    const categories = /** @type {string[]} */ ([
      ...new Set([...accordions].map((a) => a.getAttribute('data-category'))),
    ]).sort();

    if (categories.length > 0) {
      const allPill = /** @type {HTMLButtonElement} */ (document.createElement('button'));
      allPill.className = 'category-pill active';
      allPill.textContent = 'All';
      allPill.addEventListener('click', () => setActiveCategory('all', allPill));
      pillsContainer.appendChild(allPill);

      for (const cat of categories) {
        const pill = /** @type {HTMLButtonElement} */ (document.createElement('button'));
        pill.className = 'category-pill';
        pill.textContent = cat;
        pill.addEventListener('click', () => setActiveCategory(cat, pill));
        pillsContainer.appendChild(pill);
      }
    }

    searchInput.addEventListener('input', applyFilters);
  })();

  // ── Utils sub-tab switching ──────────────────────────────────────────────
  const utilsSubTabBar = document.querySelector('.utils-sub-tab-bar');
  if (utilsSubTabBar) {
    utilsSubTabBar.addEventListener('click', (e) => {
      const btn = /** @type {HTMLElement} */ (e.target);
      if (!btn.classList.contains('utils-sub-tab') || btn.classList.contains('active')) return;
      const subTabId = btn.getAttribute('data-utils-tab');
      if (!subTabId) return;
      utilsSubTabBar
        .querySelectorAll('.utils-sub-tab')
        .forEach((t) => t.classList.remove('active'));
      btn.classList.add('active');
      document
        .querySelectorAll('.utils-sub-tab-panel')
        .forEach((p) => p.classList.remove('active'));
      const panel = document.getElementById('utils-sub-tab-' + subTabId);
      if (panel) panel.classList.add('active');
    });
  }

  // ── Tab switching ────────────────────────────────────────────────────────
  const tabBar = /** @type {HTMLElement} */ (document.getElementById('tab-bar'));
  tabBar.addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement} */ (e.target);
    if (!btn.classList.contains('tab') || btn.classList.contains('active')) return;

    const tabId = btn.getAttribute('data-tab');
    if (!tabId) return;

    // Update tab buttons
    tabBar.querySelectorAll('.tab').forEach((t) => {
      t.classList.remove('active');
      t.setAttribute('aria-selected', 'false');
    });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');

    // Clear any active filter in the tab we're leaving
    document.querySelectorAll('.tab-content.active .feature-filter-input').forEach((fi) => {
      /** @type {HTMLInputElement} */ (fi).value = '';
      fi.dispatchEvent(new Event('input'));
    });

    // Update tab panels
    document.querySelectorAll('.tab-content').forEach((p) => p.classList.remove('active'));
    const panel = document.getElementById('tab-' + tabId);
    if (panel) panel.classList.add('active');
  });

  // ── Initial state ─────────────────────────────────────────────────────────
  // Signal to the extension host that the webview is fully initialized and its
  // message listener is in place. Extension host will respond with orgConnected
  // or orgDisconnected based on current connection state.
  vscode.postMessage({ type: 'ready' });
})();

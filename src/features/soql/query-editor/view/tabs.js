// @ts-check
// Query tab bar for the SOQL tab. Owns the tab list, the active
// index, and each tab's in-memory results (results are NOT persisted — only
// name/query/useToolingApi are sent to the host via saveQueryTabs). The shared
// textarea + Tooling checkbox are the live editing surface for the active tab.

/**
 * @typedef {Object} QueryTab
 * @property {string} name
 * @property {string} query
 * @property {boolean} useToolingApi
 * @property {{ records: any[], totalSize: number } | null} results
 * @property {{ message: string, diagnostics?: any } | null} error  Last failure, rendered on activate.
 * @property {string | null} opId  Id of this tab's in-flight run; null when idle. Never persisted.
 */

/**
 * @typedef {Object} QueryTabsCtx
 * @property {HTMLElement} tabBarEl
 * @property {HTMLTextAreaElement} textarea
 * @property {HTMLInputElement} toolingCheckbox
 * @property {{ postMessage: (msg: any) => void }} vscode
 * @property {(tab: QueryTab) => void} onActivate  Render the activated tab's results (or clear).
 * @property {(tab: QueryTab) => void} onTabClosed Cancel the closed tab's run, if it had one.
 */

// Pre-fill new tabs so the user doesn't retype the boilerplate; the trailing
// "FROM " puts autocomplete straight into object-suggestion mode. Keep in sync
// with DEFAULT_QUERY in src/services/QueryStateStore.ts (separate bundle).
const DEFAULT_QUERY = 'SELECT Id FROM ';

/**
 * @param {string} name @param {string} [query] @param {boolean} [useToolingApi]
 * @returns {QueryTab}
 */
function newTab(name, query = DEFAULT_QUERY, useToolingApi = false) {
  return { name, query, useToolingApi, results: null, error: null, opId: null };
}

/** @param {QueryTabsCtx} ctx */
export function createQueryTabs(ctx) {
  const { tabBarEl, textarea, toolingCheckbox, vscode, onActivate, onTabClosed } = ctx;

  /** @type {QueryTab[]} */
  let tabs = [newTab('Query 1')];
  let activeIndex = 0;
  /** @type {number | undefined} */
  let persistTimer;

  function active() {
    return tabs[activeIndex];
  }

  /** Pull the live textarea + checkbox values into the active tab. */
  function syncActiveFromUI() {
    const tab = active();
    if (!tab) return;
    tab.query = textarea.value;
    tab.useToolingApi = toolingCheckbox.checked;
  }

  /** Push the active tab's stored values into the textarea + checkbox. */
  function loadActiveIntoUI() {
    const tab = active();
    if (!tab) return;
    textarea.value = tab.query;
    toolingCheckbox.checked = tab.useToolingApi;
    // Caret at the end so a default "SELECT Id FROM " lands ready for an object.
    const len = textarea.value.length;
    textarea.setSelectionRange(len, len);
  }

  function persist() {
    vscode.postMessage({
      type: 'saveQueryTabs',
      tabs: tabs.map((t) => ({
        name: t.name,
        query: t.query,
        useToolingApi: t.useToolingApi,
      })),
      activeTab: activeIndex,
    });
  }

  /** Debounced persist for high-frequency edits (typing in the textarea). */
  function persistDebounced() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = window.setTimeout(persist, 500);
  }

  function nextName() {
    const used = new Set(tabs.map((t) => t.name));
    for (let i = 1; ; i++) {
      const name = `Query ${i}`;
      if (!used.has(name)) return name;
    }
  }

  // ── Rendering ───────────────────────────────────────────────────────────────
  function renderBar() {
    tabBarEl.innerHTML = '';
    tabs.forEach((tab, i) => {
      const pill = document.createElement('div');
      pill.className =
        'query-tab' +
        (i === activeIndex ? ' query-tab--active' : '') +
        (tab.opId ? ' query-tab--running' : '');

      const label = document.createElement('span');
      label.className = 'query-tab-label';
      // Mark a background run so it is visible without switching to the tab.
      label.textContent = tab.opId ? `${tab.name} ⋯` : tab.name;
      label.addEventListener('click', () => switchTo(i));
      label.addEventListener('dblclick', () => beginRename(i, label));
      pill.appendChild(label);

      if (tabs.length > 1) {
        const close = document.createElement('button');
        close.className = 'query-tab-close';
        close.type = 'button';
        close.textContent = '×';
        /** @type {any} */ (window).__setTooltip(close, 'Close tab');
        close.addEventListener('click', (e) => {
          e.stopPropagation();
          closeTab(i);
        });
        pill.appendChild(close);
      }
      tabBarEl.appendChild(pill);
    });

    const addBtn = document.createElement('button');
    addBtn.className = 'query-tab-add';
    addBtn.type = 'button';
    addBtn.textContent = '+';
    /** @type {any} */ (window).__setTooltip(addBtn, 'New query tab');
    addBtn.addEventListener('click', addTab);
    tabBarEl.appendChild(addBtn);
  }

  /** @param {number} i @param {HTMLElement} label */
  function beginRename(i, label) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'query-tab-rename';
    input.value = tabs[i].name;
    label.replaceWith(input);
    input.focus();
    input.select();

    const commit = () => {
      const name = input.value.trim();
      if (name) tabs[i].name = name;
      renderBar();
      persist();
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      } else if (e.key === 'Escape') {
        renderBar();
      }
    });
  }

  // ── Actions ─────────────────────────────────────────────────────────────────
  /** @param {number} i */
  function switchTo(i) {
    if (i === activeIndex) return;
    syncActiveFromUI();
    activeIndex = i;
    loadActiveIntoUI();
    renderBar();
    onActivate(active());
    persist();
  }

  function addTab() {
    syncActiveFromUI();
    tabs.push(newTab(nextName()));
    activeIndex = tabs.length - 1;
    loadActiveIntoUI();
    renderBar();
    onActivate(active());
    persist();
  }

  /** @param {number} i */
  function closeTab(i) {
    if (tabs.length <= 1) return;
    syncActiveFromUI();
    // Stop the closed tab's query before it disappears — otherwise its reply
    // would land with no owner and the toolbar would stay stuck on "Running…".
    const closed = tabs[i];
    if (closed.opId) onTabClosed(closed);
    tabs.splice(i, 1);
    if (activeIndex >= tabs.length) activeIndex = tabs.length - 1;
    else if (i < activeIndex) activeIndex--;
    loadActiveIntoUI();
    renderBar();
    onActivate(active());
    persist();
  }

  // ── Public API ──────────────────────────────────────────────────────────────
  /** @param {{ tabs?: QueryTab[], activeTab?: number }} state */
  function load(state) {
    const loaded = Array.isArray(state.tabs) && state.tabs.length > 0 ? state.tabs : null;
    // Only name/query/useToolingApi are persisted, so a reload always restores
    // idle tabs — no run can survive it.
    tabs = (loaded || [newTab('Query 1')]).map((t) =>
      newTab(t.name, t.query || '', !!t.useToolingApi),
    );
    activeIndex =
      typeof state.activeTab === 'number' && state.activeTab >= 0 && state.activeTab < tabs.length
        ? state.activeTab
        : 0;
    loadActiveIntoUI();
    renderBar();
    onActivate(active());
  }

  /** Store the just-run query's results on the active tab. */
  function setActiveResults(/** @type {{ records: any[], totalSize: number } | null} */ results) {
    const tab = active();
    if (tab) {
      tab.results = results;
      tab.error = null;
    }
  }

  // ── Per-tab run state ───────────────────────────────────────────────────────
  /** Mark the active tab as running (or idle, with null). @param {string | null} opId */
  function setActiveOpId(opId) {
    const tab = active();
    if (tab) tab.opId = opId;
    renderBar();
  }

  function getActiveOpId() {
    return active()?.opId ?? null;
  }

  /**
   * The tab that started `opId`, or undefined if it was closed, stopped or
   * superseded — in which case the caller must drop the reply.
   * @param {string | undefined} opId
   */
  function findByOpId(opId) {
    return opId ? tabs.find((t) => t.opId === opId) : undefined;
  }

  /** @returns {string[]} opIds of every tab currently running. */
  function getRunningOpIds() {
    /** @type {string[]} */
    const ids = [];
    for (const t of tabs) if (t.opId) ids.push(t.opId);
    return ids;
  }

  /** Clear every tab's run state (org disconnect, bulk cancel). */
  function clearAllOpIds() {
    for (const t of tabs) t.opId = null;
    renderBar();
  }

  /**
   * Settle one tab's run: clear its opId and store the outcome. Targets a specific
   * tab rather than `active()` so a reply always lands on the tab that started it.
   * @param {QueryTab} tab
   * @param {{ records: any[], totalSize: number } | null} results
   * @param {{ message: string, diagnostics?: any } | null} [error]
   */
  function settleRun(tab, results, error = null) {
    tab.opId = null;
    tab.results = results;
    tab.error = error;
    renderBar();
  }

  /** Called when the user edits the active query text — keep the tab + storage in sync. */
  function onActiveEdited() {
    syncActiveFromUI();
    persistDebounced();
  }

  renderBar();
  loadActiveIntoUI();

  return {
    load,
    switchTo,
    getActive: active,
    setActiveResults,
    onActiveEdited,
    persist,
    setActiveOpId,
    getActiveOpId,
    findByOpId,
    getRunningOpIds,
    clearAllOpIds,
    settleRun,
  };
}

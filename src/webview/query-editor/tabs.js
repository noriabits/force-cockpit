// @ts-check
// Query tab bar for the Overview Quick Query. Owns the tab list, the active
// index, and each tab's in-memory results (results are NOT persisted — only
// name/query/useToolingApi are sent to the host via saveQueryTabs). The shared
// textarea + Tooling checkbox are the live editing surface for the active tab.

/**
 * @typedef {Object} QueryTab
 * @property {string} name
 * @property {string} query
 * @property {boolean} useToolingApi
 * @property {{ records: any[], totalSize: number } | null} results
 */

/**
 * @typedef {Object} QueryTabsCtx
 * @property {HTMLElement} tabBarEl
 * @property {HTMLTextAreaElement} textarea
 * @property {HTMLInputElement} toolingCheckbox
 * @property {{ postMessage: (msg: any) => void }} vscode
 * @property {(tab: QueryTab) => void} onActivate  Render the activated tab's results (or clear).
 */

// Pre-fill new tabs so the user doesn't retype the boilerplate; the trailing
// "FROM " puts autocomplete straight into object-suggestion mode. Keep in sync
// with DEFAULT_QUERY in src/services/QueryStateStore.ts (separate bundle).
const DEFAULT_QUERY = 'SELECT Id FROM ';

/** @param {QueryTabsCtx} ctx */
export function createQueryTabs(ctx) {
  const { tabBarEl, textarea, toolingCheckbox, vscode, onActivate } = ctx;

  /** @type {QueryTab[]} */
  let tabs = [{ name: 'Query 1', query: DEFAULT_QUERY, useToolingApi: false, results: null }];
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
    persistTimer = setTimeout(persist, 500);
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
      pill.className = 'query-tab' + (i === activeIndex ? ' query-tab--active' : '');

      const label = document.createElement('span');
      label.className = 'query-tab-label';
      label.textContent = tab.name;
      label.addEventListener('click', () => switchTo(i));
      label.addEventListener('dblclick', () => beginRename(i, label));
      pill.appendChild(label);

      if (tabs.length > 1) {
        const close = document.createElement('button');
        close.className = 'query-tab-close';
        close.type = 'button';
        close.textContent = '×';
        close.title = 'Close tab';
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
    addBtn.title = 'New query tab';
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
    tabs.push({ name: nextName(), query: DEFAULT_QUERY, useToolingApi: false, results: null });
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
    tabs = (loaded || [{ name: 'Query 1', query: DEFAULT_QUERY, useToolingApi: false }]).map(
      (t) => ({
        name: t.name,
        query: t.query || '',
        useToolingApi: !!t.useToolingApi,
        results: null,
      }),
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
    if (tab) tab.results = results;
  }

  /** Called when the user edits the active query text — keep the tab + storage in sync. */
  function onActiveEdited() {
    syncActiveFromUI();
    persistDebounced();
  }

  renderBar();

  return { load, switchTo, getActive: active, setActiveResults, onActiveEdited, persist };
}

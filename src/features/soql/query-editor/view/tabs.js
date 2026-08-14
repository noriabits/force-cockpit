// @ts-check
import { cloneTabName, deriveTabName, isLegacyAutoName } from './tab-name';

// Query tab bar for the SOQL tab. Owns the tab list, the active
// index, and each tab's in-memory results (results are NOT persisted — only
// name/query/useToolingApi/autoName are sent to the host via saveQueryTabs). The
// shared textarea + Tooling checkbox are the live editing surface for the active tab.

/**
 * @typedef {Object} QueryTab
 * @property {string} name
 * @property {string} query
 * @property {boolean} useToolingApi
 * @property {boolean} autoName  Whether `name` tracks the FROM object automatically.
 *   False once the user renames the tab by hand; a blank rename turns it back on.
 * @property {{ records: any[], totalSize: number, soql?: string, useToolingApi?: boolean } | null} results
 *   The whole `queryResult` payload, so it also carries the request MessageRouter echoed back —
 *   the query that produced these rows, which the editor may have moved on from since.
 * @property {{ message: string, diagnostics?: any, soql?: string } | null} error  Last failure,
 *   rendered on activate; `soql` is the query that failed, for the same reason.
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
// with DEFAULT_QUERY in src/features/soql/query-editor/QueryStateStore.ts (separate bundle).
const DEFAULT_QUERY = 'SELECT Id FROM ';

/**
 * @param {string} name @param {string} [query] @param {boolean} [useToolingApi] @param {boolean} [autoName]
 * @returns {QueryTab}
 */
function newTab(name, query = DEFAULT_QUERY, useToolingApi = false, autoName = true) {
  return { name, query, useToolingApi, autoName, results: null, error: null, opId: null };
}

/** @param {QueryTabsCtx} ctx */
export function createQueryTabs(ctx) {
  const { tabBarEl, textarea, toolingCheckbox, vscode, onActivate, onTabClosed } = ctx;

  /** @type {QueryTab[]} */
  let tabs = [newTab(deriveTabName(DEFAULT_QUERY, []))];
  let activeIndex = 0;
  /** @type {number | undefined} */
  let persistTimer;
  /** Pill DOM node currently being dragged (drag-to-reorder), or null. */
  let dragEl = /** @type {HTMLElement | null} */ (null);

  function active() {
    return tabs[activeIndex];
  }

  /** Names of every tab other than `i` — the pool a new/derived name must avoid. @param {number} i */
  function otherNames(i) {
    return tabs.filter((_, idx) => idx !== i).map((t) => t.name);
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
        autoName: t.autoName,
      })),
      activeTab: activeIndex,
    });
  }

  /** Debounced persist for high-frequency edits (typing in the textarea). */
  function persistDebounced() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = window.setTimeout(persist, 500);
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
      // The pill truncates long/custom object names — the tooltip carries the full one.
      /** @type {any} */ (window).__setTooltip(label, tab.name);
      label.addEventListener('click', () => switchTo(i));
      label.addEventListener('dblclick', () => beginRename(i, label));
      pill.appendChild(label);

      if (tabs.length > 1) {
        const close = document.createElement('button');
        close.className = 'query-tab-close';
        close.type = 'button';
        close.textContent = '×';
        /** @type {any} */ (window).__setTooltip(close, 'Close tab');
        // Never let a mousedown here be read as the start of a pill drag.
        close.setAttribute('draggable', 'false');
        close.addEventListener('click', (e) => {
          e.stopPropagation();
          closeTab(i);
        });
        pill.appendChild(close);
      }

      // Drag-to-reorder: the whole pill is the drag source (small pill, no
      // handle needed — unlike the monitoring card grid's interactive cards).
      // Identity for commitTabOrder() is the tab object reference itself.
      /** @type {any} */ (pill).__tab = tab;
      pill.draggable = true;
      pill.addEventListener('dragstart', (e) => {
        dragEl = pill;
        pill.classList.add('query-tab--dragging');
        const dt = /** @type {DataTransfer | null} */ (e.dataTransfer);
        if (dt) dt.effectAllowed = 'move';
      });
      pill.addEventListener('dragend', () => {
        pill.classList.remove('query-tab--dragging');
        const wasDragging = dragEl === pill;
        dragEl = null;
        if (wasDragging) commitTabOrder();
      });

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

  /**
   * The pill closest to (x, y), excluding `excluded`. Euclidean distance
   * rather than a plain left/right check — the bar wraps to multiple rows
   * once enough tabs are open (`.query-tab-bar { flex-wrap: wrap }`).
   * @param {HTMLElement} excluded @param {number} x @param {number} y
   */
  function findClosestTabPill(excluded, x, y) {
    const pills = /** @type {HTMLElement[]} */ (
      Array.from(tabBarEl.querySelectorAll('.query-tab'))
    ).filter((p) => p !== excluded);
    let best = /** @type {HTMLElement | null} */ (null);
    let bestDist = Infinity;
    for (const pill of pills) {
      const rect = pill.getBoundingClientRect();
      const dx = x - (rect.left + rect.width / 2);
      const dy = y - (rect.top + rect.height / 2);
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        best = pill;
      }
    }
    return best;
  }

  /**
   * After a drag-drop, rebuild `tabs` to match the pills' final DOM order.
   * Identity comes from the `__tab` reference stashed on each pill at render
   * time, so no index/id bookkeeping is needed — `activeIndex` is remapped
   * to wherever the tab that was active before the drag ended up.
   */
  function commitTabOrder() {
    const activeTab = active();
    const newOrder = /** @type {QueryTab[]} */ (
      Array.from(tabBarEl.querySelectorAll('.query-tab'))
        .map((p) => /** @type {any} */ (p).__tab)
        .filter(Boolean)
    );
    if (newOrder.length !== tabs.length) return; // safety guard, shouldn't happen
    tabs = newOrder;
    activeIndex = tabs.indexOf(activeTab);
    renderBar();
    persist();
  }

  /** @param {number} i @param {HTMLElement} label */
  function beginRename(i, label) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'query-tab-rename';
    input.value = tabs[i].name;
    // Selecting/typing in the rename input must never be read as a drag start.
    const pill = label.parentElement;
    if (pill) /** @type {HTMLElement} */ (pill).draggable = false;
    label.replaceWith(input);
    input.focus();
    input.select();

    const commit = () => {
      const name = input.value.trim();
      // A non-empty name is a manual override; clearing it hands the tab back
      // to auto-naming, re-derived below.
      tabs[i].autoName = !name;
      if (name) tabs[i].name = name;
      else tabs[i].name = deriveTabName(tabs[i].query, otherNames(i), tabs[i].name);
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
    tabs.push(
      newTab(
        deriveTabName(
          DEFAULT_QUERY,
          tabs.map((t) => t.name),
        ),
      ),
    );
    activeIndex = tabs.length - 1;
    loadActiveIntoUI();
    renderBar();
    onActivate(active());
    persist();
  }

  /** Duplicate the active tab (name, query, Tooling toggle) into a new tab right after it. */
  function cloneActive() {
    syncActiveFromUI();
    const source = active();
    if (!source) return;
    tabs.splice(
      activeIndex + 1,
      0,
      newTab(
        cloneTabName(
          source.name,
          tabs.map((t) => t.name),
          source.autoName,
        ),
        source.query,
        source.useToolingApi,
        source.autoName,
      ),
    );
    activeIndex++;
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
    // Only name/query/useToolingApi/autoName are persisted, so a reload always
    // restores idle tabs — no run can survive it.
    tabs = (loaded || [newTab(deriveTabName(DEFAULT_QUERY, []))]).map((t) =>
      newTab(
        t.name,
        t.query || '',
        !!t.useToolingApi,
        // Tabs saved before this feature carry no autoName flag — tell a leftover
        // "Query 3" (safe to re-derive) from a name the user actually chose.
        typeof t.autoName === 'boolean' ? t.autoName : isLegacyAutoName(t.name),
      ),
    );
    // Re-derive every auto-named tab in order, each seeing names already settled.
    let renamed = false;
    tabs.forEach((t, i) => {
      if (!t.autoName) return;
      const name = deriveTabName(t.query, otherNames(i), t.name);
      if (name !== t.name) {
        t.name = name;
        renamed = true;
      }
    });
    activeIndex =
      typeof state.activeTab === 'number' && state.activeTab >= 0 && state.activeTab < tabs.length
        ? state.activeTab
        : 0;
    loadActiveIntoUI();
    renderBar();
    onActivate(active());
    if (renamed) persist();
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
   * @param {QueryTab['results']} results
   * @param {QueryTab['error']} [error]
   */
  function settleRun(tab, results, error = null) {
    tab.opId = null;
    tab.results = results;
    tab.error = error;
    renderBar();
  }

  /**
   * Re-derive the active tab's name from its (just-synced) query text, unless it
   * carries a manual name. Only re-renders the bar when the name actually changed,
   * so this stays cheap to call on every keystroke.
   */
  function refreshActiveName() {
    const tab = active();
    if (!tab || !tab.autoName) return;
    const name = deriveTabName(tab.query, otherNames(activeIndex), tab.name);
    if (name === tab.name) return;
    tab.name = name;
    renderBar();
  }

  /** Called when the user edits the active query text — keep the tab + storage in sync. */
  function onActiveEdited() {
    syncActiveFromUI();
    refreshActiveName();
    persistDebounced();
  }

  /**
   * Set the active tab's name explicitly and mark it manual, so it stops
   * tracking the FROM object — used when loading a saved query, so the tab
   * takes the query's own label instead of being renamed after its object.
   * Mirrors `beginRename`'s manual-name path: no dedup against other open
   * tabs, since the name was chosen on purpose, same as typing it by hand.
   * @param {string} name
   */
  function setActiveName(name) {
    const tab = active();
    if (!tab || !name) return;
    tab.name = name;
    tab.autoName = false;
    renderBar();
    persist();
  }

  // Bar-level dragover: live-shuffles the dragged pill via findClosestTabPill
  // + insertBefore, mirroring the monitoring card grid's drag-reorder. Wired
  // once here (not per renderBar call) since tabBarEl itself is never
  // recreated, only its children.
  tabBarEl.addEventListener('dragover', (e) => {
    if (!dragEl) return;
    e.preventDefault();
    const dt = /** @type {DataTransfer | null} */ (/** @type {DragEvent} */ (e).dataTransfer);
    if (dt) dt.dropEffect = 'move';
    const target = findClosestTabPill(dragEl, e.clientX, e.clientY);
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const isAfter = e.clientX > rect.left + rect.width / 2;
    if (isAfter) {
      if (target.nextSibling !== dragEl) tabBarEl.insertBefore(dragEl, target.nextSibling);
    } else if (dragEl.nextSibling !== target) {
      tabBarEl.insertBefore(dragEl, target);
    }
  });

  renderBar();
  loadActiveIntoUI();

  return {
    load,
    switchTo,
    cloneActive,
    getActive: active,
    setActiveResults,
    onActiveEdited,
    setActiveName,
    persist,
    setActiveOpId,
    getActiveOpId,
    findByOpId,
    getRunningOpIds,
    clearAllOpIds,
    settleRun,
  };
}

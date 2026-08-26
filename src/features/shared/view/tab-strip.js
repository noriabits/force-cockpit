// @ts-check
import { cloneName, deriveName, shouldRevertToAuto } from './tab-naming';
import { resolveDropTarget } from './tab-drop-target';

/**
 * The tab bar shared by the SOQL query tabs and the REST request tabs. Owns the
 * tab list, the active index, each tab's in-memory outcome, and each tab's
 * in-flight run — everything that is the same whatever a tab actually holds.
 *
 * What a tab holds is the feature's business: the strip never names a payload
 * field, going through `readUI`/`writeUI`/`payloadOf`/`baseNameFor`/`isPristine`
 * instead. Payload fields live **flat on the tab object** rather than nested
 * under `tab.payload`, so a feature's own code (and its persisted records) can go
 * on reading `tab.query` / `tab.endpoint` directly and needed no migration when
 * this was extracted.
 *
 * Only the payload, `name`, `autoName` and `nameObject` are persisted — `results`,
 * `error` and `opId` are in-memory, so a reload always restores idle tabs.
 *
 * The live controls (a textarea, a set of inputs) are the editing surface for
 * whichever tab is active; switching tabs writes the old one back and loads the
 * new one in.
 */

// How far the cursor must travel between two reorders of the dragged pill.
// `dragover` keeps firing while the pointer sits still, so any layout that
// resolves differently after a reorder would otherwise bounce the pill back
// and forth forever; requiring real pointer travel means a still cursor always
// settles, and the wrapping bar can at worst step, never blink.
const REORDER_DEADZONE_PX = 6;

/**
 * @typedef {Object} StripTab
 * @property {string} name
 * @property {boolean} autoName  Whether `name` tracks the tab's content automatically.
 *   False once the user renames the tab by hand; a blank rename turns it back on.
 * @property {string | null} nameObject  The base name a label adopted from a saved entry
 *   was taken under. Set only on that path: it is what lets the name hold while the tab
 *   still matches that base and lapse back to auto-naming once it doesn't.
 * @property {any} results  Last successful outcome, rendered on activate. Opaque here.
 * @property {any} error  Last failure, rendered on activate. Opaque here.
 * @property {string | null} opId  Id of this tab's in-flight run; null when idle. Never persisted.
 */

/**
 * @typedef {Object} TabStripCtx
 * @property {HTMLElement} tabBarEl
 * @property {{ postMessage: (msg: any) => void }} vscode
 * @property {string} persistType  Message type the tab list is persisted under.
 * @property {() => any} newPayload  Payload for a brand-new tab.
 * @property {(record: any) => any} payloadOf  The persisted payload fields of a tab/record.
 * @property {() => any} readUI  Payload as the live controls currently hold it.
 * @property {(tab: any) => void} writeUI  Push a tab's payload into the live controls.
 * @property {(tab: any) => string} baseNameFor  The tab's label before de-duplication.
 * @property {(tab: any) => boolean} isPristine  Whether the payload holds nothing worth keeping.
 * @property {(name: string) => boolean} [legacyAutoName]  For records persisted before
 *   `autoName` existed: whether the stored name was auto-generated (safe to re-derive).
 * @property {string} addTooltip  Tooltip for the `+` button.
 * @property {(tab: any) => void} onActivate  Render the activated tab's outcome (or clear).
 * @property {(tab: any) => void} onTabClosed  Cancel the closed tab's run, if it had one.
 */

/** @param {TabStripCtx} ctx */
export function createTabStrip(ctx) {
  const {
    tabBarEl,
    vscode,
    persistType,
    newPayload,
    payloadOf,
    readUI,
    writeUI,
    baseNameFor,
    isPristine,
    legacyAutoName,
    addTooltip,
    onActivate,
    onTabClosed,
  } = ctx;

  /**
   * @param {string} name @param {any} [payload] @param {boolean} [autoName]
   * @param {string | null} [nameObject]
   * @returns {any}
   */
  function newTab(name, payload = newPayload(), autoName = true, nameObject = null) {
    return { name, ...payload, autoName, nameObject, results: null, error: null, opId: null };
  }

  /** @type {any[]} */
  let tabs = [];
  let activeIndex = 0;
  /** @type {number | undefined} */
  let persistTimer;
  /** Pill DOM node currently being dragged (drag-to-reorder), or null. */
  let dragEl = /** @type {HTMLElement | null} */ (null);
  /** Cursor position of the last reorder (drag start counts) — see REORDER_DEADZONE_PX. */
  let lastDropX = 0;
  let lastDropY = 0;
  /** Set when renderBar() was skipped mid-drag and still owes a render at dragend. */
  let renderQueued = false;

  function active() {
    return tabs[activeIndex];
  }

  /** Names of every tab other than `i` — the pool a new/derived name must avoid. @param {number} i */
  function otherNames(i) {
    return tabs.filter((_, idx) => idx !== i).map((t) => t.name);
  }

  /** Every tab's name — the pool for a name that isn't replacing an existing one. */
  function allNames() {
    return tabs.map((t) => t.name);
  }

  /** Pull the live control values into the active tab. */
  function syncActiveFromUI() {
    const tab = active();
    if (!tab) return;
    Object.assign(tab, readUI());
  }

  /** Push the active tab's stored values into the live controls. */
  function loadActiveIntoUI() {
    const tab = active();
    if (!tab) return;
    writeUI(tab);
  }

  function persist() {
    vscode.postMessage({
      type: persistType,
      tabs: tabs.map((t) => ({
        name: t.name,
        ...payloadOf(t),
        autoName: t.autoName,
        nameObject: t.nameObject,
      })),
      activeTab: activeIndex,
    });
  }

  /** Debounced persist for high-frequency edits (typing). */
  function persistDebounced() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = window.setTimeout(persist, 500);
  }

  // ── Rendering ───────────────────────────────────────────────────────────────
  function renderBar() {
    // A drag owns the pill DOM until it ends. Rebuilding the bar mid-drag would
    // tear out the drag source (which cancels the browser's native drag) and
    // leave `dragEl` pointing at a detached node that the dragover handler would
    // then splice back in beside its freshly rendered twin. Renders can arrive
    // at any moment from a reply (setActiveOpId / settleRun / clearAllOpIds),
    // so park them until dragend.
    if (dragEl) {
      renderQueued = true;
      return;
    }
    renderQueued = false;
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
      // The pill truncates long names — the tooltip carries the full one.
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
        // Measure the dead zone from where the drag began, so the pill holds its
        // slot until the pointer has actually moved somewhere.
        lastDropX = e.clientX;
        lastDropY = e.clientY;
        // A drag suppresses the pill's own click event, so switching tabs on
        // click never fires here — activate explicitly. Can't call switchTo
        // (renderBar would destroy this very pill mid-drag and cancel the
        // browser's native drag operation), so update in place instead.
        activateForDrag(i, pill);
        const dt = /** @type {DataTransfer | null} */ (e.dataTransfer);
        if (dt) {
          dt.effectAllowed = 'move';
          // A drag carrying no data isn't guaranteed to start at all. The payload
          // itself goes unused — reorder identity is the `__tab` reference above.
          dt.setData('text/plain', tab.name);
        }
      });
      pill.addEventListener('dragend', () => {
        pill.classList.remove('query-tab--dragging');
        const wasDragging = dragEl === pill;
        dragEl = null;
        if (wasDragging) commitTabOrder();
        else if (renderQueued) renderBar();
      });

      tabBarEl.appendChild(pill);
    });

    const addBtn = document.createElement('button');
    addBtn.className = 'query-tab-add';
    addBtn.type = 'button';
    addBtn.textContent = '+';
    /** @type {any} */ (window).__setTooltip(addBtn, addTooltip);
    addBtn.addEventListener('click', addTab);
    tabBarEl.appendChild(addBtn);
  }

  /** Every pill in the bar except `excluded`, in DOM order. @param {HTMLElement} excluded */
  function otherTabPills(excluded) {
    return /** @type {HTMLElement[]} */ (
      Array.from(tabBarEl.querySelectorAll('.query-tab'))
    ).filter((p) => p !== excluded);
  }

  /**
   * After a drag-drop, rebuild `tabs` to match the pills' final DOM order.
   * Identity comes from the `__tab` reference stashed on each pill at render
   * time, so no index/id bookkeeping is needed — `activeIndex` is remapped
   * to wherever the tab that was active before the drag ended up.
   */
  function commitTabOrder() {
    const activeTab = active();
    const newOrder = /** @type {any[]} */ (
      Array.from(tabBarEl.querySelectorAll('.query-tab'))
        .map((p) => /** @type {any} */ (p).__tab)
        .filter(Boolean)
    );
    // Take the DOM's word for the order only when the pills still describe the
    // same set of tabs — i.e. a permutation of `tabs`. They may not: a render
    // deferred by the drag (see renderBar) can have replaced the model under
    // pills the user was still dragging, e.g. a load() landing mid-drag. In
    // that case keep `tabs` as it is and let the render below put the pills
    // back in the model's order, rather than leaving the bar showing an order
    // nobody holds — or worse, reinstating tabs the model has moved past.
    const isReorder = newOrder.length === tabs.length && newOrder.every((t) => tabs.includes(t));
    if (isReorder) {
      tabs = newOrder;
      const movedTo = tabs.indexOf(activeTab);
      if (movedTo >= 0) activeIndex = movedTo;
      persist();
    }
    renderBar();
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
      // Either way the tab stops tracking a saved entry's label: a typed name is
      // the user's own and permanent, a cleared one hands back to the content.
      tabs[i].nameObject = null;
      if (name) tabs[i].name = name;
      else tabs[i].name = deriveName(baseNameFor(tabs[i]), otherNames(i), tabs[i].name);
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

  /**
   * Same effect as `switchTo`, but updates the `--active` class on the
   * existing pills in place instead of calling `renderBar()` — used from
   * `dragstart`, where a full rebuild would tear out `pill` (the drag
   * source) mid-drag and end the browser's native drag operation.
   * @param {number} i @param {HTMLElement} pill
   */
  function activateForDrag(i, pill) {
    if (i === activeIndex) return;
    syncActiveFromUI();
    const prevActive = tabBarEl.querySelector('.query-tab--active');
    if (prevActive) prevActive.classList.remove('query-tab--active');
    activeIndex = i;
    loadActiveIntoUI();
    pill.classList.add('query-tab--active');
    onActivate(active());
    persist();
  }

  function addTab() {
    syncActiveFromUI();
    const fresh = newTab('');
    fresh.name = deriveName(baseNameFor(fresh), allNames());
    tabs.push(fresh);
    activeIndex = tabs.length - 1;
    loadActiveIntoUI();
    renderBar();
    onActivate(active());
    persist();
  }

  /** Duplicate the active tab (name + payload) into a new tab right after it. */
  function cloneActive() {
    syncActiveFromUI();
    const source = active();
    if (!source) return;
    tabs.splice(
      activeIndex + 1,
      0,
      newTab(
        cloneName(source.name, allNames(), source.autoName),
        payloadOf(source),
        source.autoName,
        source.nameObject,
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
    // Stop the closed tab's run before it disappears — otherwise its reply
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
  /** @param {{ tabs?: any[], activeTab?: number }} state */
  function load(state) {
    const loaded = Array.isArray(state.tabs) && state.tabs.length > 0 ? state.tabs : null;
    // Only the payload/name/autoName/nameObject are persisted, so a reload always
    // restores idle tabs — no run can survive it.
    tabs = (loaded || [newTab('')]).map((t) =>
      newTab(
        t.name,
        payloadOf(t),
        // Records saved before autoName existed carry no flag — ask the feature
        // whether the stored name looks auto-generated (safe to re-derive).
        typeof t.autoName === 'boolean' ? t.autoName : !!legacyAutoName?.(t.name),
        typeof t.nameObject === 'string' ? t.nameObject : null,
      ),
    );
    // Re-derive every auto-named tab in order, each seeing names already settled.
    let renamed = false;
    tabs.forEach((t, i) => {
      if (!t.autoName) return;
      const name = deriveName(baseNameFor(t), otherNames(i), t.name);
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

  /** Store the just-run outcome on the active tab. @param {any} results */
  function setActiveResults(results) {
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
   * @param {any} tab @param {any} results @param {any} [error]
   */
  function settleRun(tab, results, error = null) {
    tab.opId = null;
    tab.results = results;
    tab.error = error;
    renderBar();
  }

  /**
   * Re-derive the active tab's name from its (just-synced) content, unless it
   * carries a manual name. Only re-renders the bar when the name actually changed,
   * so this stays cheap to call on every keystroke.
   */
  function refreshActiveName() {
    const tab = active();
    if (!tab) return;
    // A label adopted from a saved entry only holds while the tab still matches
    // the base it was loaded for; past that the tab goes back to auto-naming.
    // A name typed by hand carries no nameObject and never reverts.
    if (!tab.autoName && shouldRevertToAuto(baseNameFor(tab), tab.nameObject)) {
      tab.autoName = true;
      tab.nameObject = null;
    }
    if (!tab.autoName) return;
    const name = deriveName(baseNameFor(tab), otherNames(activeIndex), tab.name);
    if (name === tab.name) return;
    tab.name = name;
    renderBar();
  }

  /** Called when the user edits the active tab — keep the tab + storage in sync. */
  function onActiveEdited() {
    syncActiveFromUI();
    refreshActiveName();
    persistDebounced();
  }

  /**
   * Whether the active tab holds nothing worth keeping: an untouched payload,
   * no stored outcome, nothing in flight.
   */
  function isActivePristine() {
    const tab = active();
    if (!tab || tab.opId || tab.results || tab.error) return false;
    return isPristine(tab);
  }

  /**
   * Open an entry picked from the History dropdown in its own tab, right after the
   * active one — a pick must never overwrite what the user has open. A pristine
   * active tab is reused instead, so picking from a fresh tab leaves no blank behind.
   *
   * `name` (Saved picks only) becomes the tab's label, held only while the tab still
   * matches that base — see `shouldRevertToAuto`. A Recent pick has no label and is
   * auto-named from its content like any other tab.
   * @param {{ payload: any, name?: string }} entry
   */
  function openTab(entry) {
    // The pristine test reads the tab, so the live controls have to land there first.
    syncActiveFromUI();
    const reuse = isActivePristine();
    const tab = reuse ? active() : newTab('', entry.payload);
    if (!reuse) {
      tabs.splice(activeIndex + 1, 0, tab);
      activeIndex++;
    }
    Object.assign(tab, entry.payload);
    tab.results = null;
    tab.error = null;
    if (entry.name) {
      // No dedup against other open tabs: the label was chosen on purpose, same
      // as a name typed by hand — two tabs may legitimately show one saved entry.
      tab.name = entry.name;
      tab.autoName = false;
      tab.nameObject = baseNameFor(tab);
    } else {
      tab.autoName = true;
      tab.nameObject = null;
      // No currentName: a reused tab must take the picked entry's own name, not
      // stick with whatever the tab was called before.
      tab.name = deriveName(baseNameFor(tab), otherNames(activeIndex));
    }
    loadActiveIntoUI();
    renderBar();
    onActivate(active());
    persist();
  }

  // Bar-level dragover: live-shuffles the dragged pill into the slot the cursor
  // is over (resolveDropTarget + insertBefore). Wired once here (not per
  // renderBar call) since tabBarEl itself is never recreated, only its children.
  tabBarEl.addEventListener('dragover', (e) => {
    if (!dragEl) return;
    // Marks the bar as a drop target, so the pill drops here instead of the
    // browser refusing the drop and animating it back to where it started.
    e.preventDefault();
    const dt = /** @type {DataTransfer | null} */ (/** @type {DragEvent} */ (e).dataTransfer);
    if (dt) dt.dropEffect = 'move';
    if (
      Math.abs(e.clientX - lastDropX) < REORDER_DEADZONE_PX &&
      Math.abs(e.clientY - lastDropY) < REORDER_DEADZONE_PX
    ) {
      return;
    }
    const pills = otherTabPills(dragEl);
    const target = resolveDropTarget(
      pills.map((p) => p.getBoundingClientRect()),
      e.clientX,
      e.clientY,
    );
    if (!target) return;
    const pill = pills[target.index];
    // The node the pill should sit before — the add button when it lands last.
    const before = target.after ? pill.nextSibling : pill;
    // Already in that slot: skip, so an unchanged order never re-inserts the
    // drag source (a needless DOM move under an in-flight native drag).
    if (before === dragEl || dragEl.nextSibling === before) return;
    tabBarEl.insertBefore(dragEl, before);
    lastDropX = e.clientX;
    lastDropY = e.clientY;
  });

  // The drop itself carries nothing — the pill is already where the live shuffle
  // left it and dragend commits the order — but accepting it keeps the browser
  // from playing the "rejected drop" snap-back animation over the bar.
  tabBarEl.addEventListener('drop', (e) => e.preventDefault());

  // Seed the one default tab, then paint. The caller's `onActivate` is not fired
  // for this initial hydration — `load()` (or the caller itself) does that.
  tabs = [newTab('')];
  tabs[0].name = deriveName(baseNameFor(tabs[0]), []);
  renderBar();
  loadActiveIntoUI();

  return {
    load,
    switchTo,
    cloneActive,
    getActive: active,
    setActiveResults,
    onActiveEdited,
    openTab,
    persist,
    setActiveOpId,
    getActiveOpId,
    findByOpId,
    getRunningOpIds,
    clearAllOpIds,
    settleRun,
  };
}

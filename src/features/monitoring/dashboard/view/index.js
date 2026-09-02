// @ts-check
// Monitoring dashboard webview orchestrator. Owns state, DOM refs, the shared
// filter bar, card shells, query dispatch, auto-refresh timers, and feature
// registration. Chart rendering, table rendering, the edit form, and drag
// reordering are delegated to focused sibling modules (each created via a
// factory that receives a ctx so it never reaches into this scope directly).
import { createCategoryFilterBar } from '../../../shared/view/category-filter-bar.js';
import { applyListFilter } from '../../../shared/view/list-filter';
import { createChartRenderer } from './chart-rendering';
import { createTableRenderer } from './table-rendering';
import { createEditForm, drainOpenEditForms, resolveReply } from './edit-form';
import { createDragOrder } from './drag-order';
import { createQueryRunner } from './query-runner';
import { createRefreshScheduler } from './refresh-scheduler';
import { createCardBuilder } from './card-builder';
import { createConfigLoader } from './config-loader';
import { hasNotifications } from '../notification-config';

(function () {
  const win = /** @type {any} */ (window);
  const L = win.MonitoringLabels;
  const vscode = win.__vscode;

  // ── State ──────────────────────────────────────────────────────────────────
  let connected = false;
  let isVisible = true; // Track panel visibility to pause auto-refresh when hidden
  let configs = /** @type {any[]} */ ([]);
  let searchQuery = '';
  /** Track connected org to avoid re-rendering on focus-regain with the same org */
  let connectedOrgId = /** @type {string | null} */ (null);
  /** Configs loaded while monitoring tab was hidden — queries deferred until visible */
  let pendingInitialLoad = false;
  /** @type {Map<string, any>} configId → Chart instance */
  const chartInstances = new Map();

  // ── DOM refs ───────────────────────────────────────────────────────────────
  const monitoringPanel = /** @type {HTMLElement} */ (document.getElementById('monitoring-panel'));
  const grid = /** @type {HTMLElement} */ (document.getElementById('monitoring-grid'));
  const pillsContainer = /** @type {HTMLElement} */ (
    document.getElementById('monitoring-folder-pills')
  );
  const searchInput = /** @type {HTMLInputElement} */ (
    document.getElementById('monitoring-search')
  );
  const noResults = /** @type {HTMLElement} */ (document.getElementById('monitoring-no-results'));
  const loadError = /** @type {HTMLElement} */ (document.getElementById('monitoring-load-error'));
  const addBtn = /** @type {HTMLButtonElement} */ (document.getElementById('monitoring-add-btn'));
  const subPillsEl = /** @type {HTMLElement} */ (document.getElementById('monitoring-sub-pills'));
  const visibilityFilterEl = /** @type {HTMLElement} */ (
    document.getElementById('monitoring-visibility-filter')
  );

  // ── Category/visibility filter bar (shared module) ─────────────────────────
  const filterBar = createCategoryFilterBar({
    visibilityEl: visibilityFilterEl,
    pillsEl: pillsContainer,
    subPillsEl,
    visibilityOptions: [
      { value: 'all', label: L.filterAll },
      { value: 'shared', label: L.filterShared },
      { value: 'private', label: L.filterPrivate },
    ],
    labels: { pillAll: L.pillAll, pillSubAll: L.pillSubAll },
    getItems: () => configs,
    onChange: () => applyFilters(),
  });

  // ── Delegated rendering modules ────────────────────────────────────────────
  const chartRenderer = createChartRenderer({ chartInstances, labels: L, setCardStatus });
  const tableRenderer = createTableRenderer({ grid, labels: L, setCardStatus, vscode });
  const dragOrder = createDragOrder({ grid, getConfigs: () => configs, vscode });
  const queryRunner = createQueryRunner({
    labels: L,
    vscode,
    grid,
    getConnected: () => connected,
    getConfigs: () => configs,
    chartRenderer,
    tableRenderer,
    setCardStatus,
    setCardError,
    findCardTypeSelect,
  });
  const triggerQuery = queryRunner.triggerQuery;
  const refreshScheduler = createRefreshScheduler({
    getConnected: () => connected,
    getIsVisible: () => isVisible,
    triggerQuery,
  });
  const { setupAutoRefresh, clearAutoRefresh, clearAllRefreshTimers } = refreshScheduler;
  const cardBuilder = createCardBuilder({
    labels: L,
    getConnected: () => connected,
    chartRenderer,
    dragOrder,
    setupAutoRefresh,
    triggerQuery,
    onEditClick: (/** @type {any} */ cfg, /** @type {HTMLElement} */ card) =>
      switchToEditMode(cfg, card),
  });
  const { buildViewCard } = cardBuilder;
  const editForm = createEditForm({
    labels: L,
    // No `vscode` here: the form posts through the typed `post()` seam
    // (shared/view/host.tsx) rather than an injected raw postMessage.
    chartInstances,
    getConfigs: () => configs,
    nextAvailablePosition: () => dragOrder.nextAvailablePosition(),
    buildViewCard,
    triggerQuery,
  });
  const configLoader = createConfigLoader({
    labels: L,
    vscode,
    loadErrorEl: loadError,
    monitoringPanel,
    drainEditForms: () => drainOpenEditForms(grid),
    resolveReply: (/** @type {unknown} */ requestId) => resolveReply(grid, requestId),
    applyConfigs: (/** @type {any[]} */ sorted) => {
      configs = sorted;
      renderAll(configs);
    },
  });
  const { loadConfigs, onConfigsLoaded, onDeleteResult, onDeleteError, showLoadError } =
    configLoader;

  // ── Init ───────────────────────────────────────────────────────────────────
  addBtn.textContent = L.btnAddChart;
  noResults.textContent = L.noResults;

  addBtn.addEventListener('click', () => {
    if (!connected) return;
    addNewCard();
  });

  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value.toLowerCase();
    applyFilters();
  });

  dragOrder.init();

  // ── Tab visibility observer ────────────────────────────────────────────────
  // Charts rendered inside a display:none container get 0×0 dimensions and show
  // no colours. Defer the initial query run until the panel is actually visible,
  // and resize any charts that were created while hidden.
  const panelObserver = new IntersectionObserver(
    (entries) => {
      if (entries[0].isIntersecting) {
        chartInstances.forEach((/** @type {any} */ chart) => chart.resize());
        if (connected && pendingInitialLoad) {
          pendingInitialLoad = false;
          for (const cfg of configs) {
            triggerQuery(cfg);
          }
        }
      }
    },
    { threshold: 0 },
  );
  panelObserver.observe(monitoringPanel);

  /**
   * Host -> webview dispatch, one entry per message name.
   *
   * Converted from a 13-arm `switch` that measured a complexity of 25, matching
   * `yaml-scripts/view/index.js`, `debug-logs/explorer/view/index.js` and
   * `overview/ask-ai/view/index.js`. Handlers take `message.data` verbatim —
   * NOT `?? {}` — because several arms read a field straight off it and a
   * silent `{}` would turn a malformed reply into an undefined payload rather
   * than a visible throw.
   *
   * @type {Record<string, (data: any) => void>}
   */
  const messageHandlers = {
    loadMonitoringConfigsResult: (data) => onConfigsLoaded(data.configs, data.hiddenCount || 0),
    // Touches no form. A reload failing is not the same event as "the reload my
    // save asked for failed" — `loadConfigs()` is also called by a confirmed
    // delete, the restore-hidden-built-ins reply and an org reconnect. Every
    // submit is settled by its OWN correlated reply.
    loadMonitoringConfigsError: (data) => showLoadError(data.message),

    runMonitoringQueryResult: (data) => queryRunner.onQueryResult(data),
    runMonitoringQueryError: (data) => queryRunner.onQueryError(data),
    runMonitoringTableQueryResult: (data) => queryRunner.onTableQueryResult(data),
    runMonitoringTableQueryError: (data) => queryRunner.onQueryError(data),

    saveMonitoringConfigResult: (data) => onSaveResult(data),
    saveMonitoringConfigError: (data) => onSaveError(data),
    deleteMonitoringConfigResult: (data) => onDeleteResult(data),
    deleteMonitoringConfigError: (data) => onDeleteError(data),
    restoreHiddenBuiltinsResult: () => loadConfigs(),

    monitoringBackgroundRefreshResult: (data) => {
      const { configId, chartType, result, rowCountIncreased } = data || {};
      if (!configId || !result) return;
      const payload = { ...result, configId, rowCountIncreased };
      // Mirror the manual-refresh paths so the same render code runs
      if (chartType === 'table') queryRunner.onTableQueryResult(payload);
      else queryRunner.onQueryResult(payload);
    },

    panelVisibilityChanged: (data) => {
      isVisible = data.visible || false;
      // If panel became visible, resume refresh timers by re-triggering queries.
      // Skip notification-enabled configs — the host's BackgroundRefresher keeps
      // those fresh, so re-querying here would just double-fire notifications.
      if (!isVisible || !connected) return;
      for (const cfg of configs) {
        if (cfg.refreshInterval > 0 && !hasNotifications(cfg)) {
          triggerQuery(cfg);
        }
      }
    },
  };
  // ── Feature registration ───────────────────────────────────────────────────
  win.__registerFeature('monitoring-dashboard', {
    onOrgConnected: function (/** @type {any} */ org) {
      connected = true;
      addBtn.disabled = false;
      const orgIdentifier = org && (org.orgId || org.username);
      const sameOrg = orgIdentifier && orgIdentifier === connectedOrgId;
      connectedOrgId = orgIdentifier || null;
      if (!sameOrg || configs.length === 0) {
        // Different org or first load — reload configs from disk
        loadConfigs();
      } else {
        // Same org regained focus (e.g. user clicked elsewhere and back) — re-enable buttons
        // without wiping any in-progress edit state
        setAllButtonsDisabled(false);
      }
    },
    onOrgDisconnected: function () {
      connected = false;
      connectedOrgId = null;
      addBtn.disabled = true;
      clearAllRefreshTimers();
      setAllButtonsDisabled(true);
    },
    onMessage: function (/** @type {any} */ message) {
      const handler = messageHandlers[message.type];
      if (handler) handler(message.data);
    },
  });

  // ── Render all cards ───────────────────────────────────────────────────────
  /** @param {any[]} cfgs */
  function renderAll(cfgs) {
    // Destroy existing chart instances and timers
    chartInstances.forEach((/** @type {any} */ chart) => chart.destroy());
    chartInstances.clear();
    clearAllRefreshTimers();

    grid.innerHTML = '';

    // Monitoring intentionally resets all filters on a full reload
    filterBar.reset();

    if (cfgs.length === 0) {
      noResults.textContent = L.noConfigs;
      noResults.style.display = '';
      return;
    }

    for (const cfg of cfgs) {
      const card = buildViewCard(cfg);
      grid.appendChild(card);
    }

    applyFilters();

    // Only trigger queries when the monitoring tab is actually visible.
    // If the panel is hidden (display:none from an inactive tab), Chart.js
    // would create charts at 0×0 — showing no colours. Defer until visible.
    if (connected) {
      if (monitoringPanel.offsetParent !== null) {
        for (const cfg of cfgs) {
          triggerQuery(cfg);
        }
      } else {
        pendingInitialLoad = true;
      }
    }
  }

  // ── Filters ────────────────────────────────────────────────────────────────
  function isFiltered() {
    return filterBar.isFiltered() || searchQuery !== '';
  }

  function applyFilters() {
    const cards = /** @type {NodeListOf<HTMLElement>} */ (
      grid.querySelectorAll('.card[data-config-id]')
    );
    const filtered = isFiltered();

    let visibleCount = applyListFilter({
      elements: cards,
      getAttrs: (card) => ({
        folder: card.getAttribute('data-folder') || '',
        source: card.getAttribute('data-source') || '',
        searchText: card.getAttribute('data-search-text') || '',
      }),
      matches: (item) => filterBar.matches(item),
      query: searchQuery,
    });

    // Hide drag handles when filtered (drag itself is gated on the handle's mousedown)
    for (const card of cards) {
      const handle = card.querySelector('.monitoring-drag-handle');
      if (handle) /** @type {HTMLElement} */ (handle).style.display = filtered ? 'none' : '';
    }

    // Also check "new card" in edit mode (no data-config-id)
    const newCard = grid.querySelector('.card[data-new-card]');
    if (newCard) visibleCount++;

    noResults.textContent = L.noResults;
    noResults.style.display = visibleCount === 0 && configs.length > 0 ? '' : 'none';
  }

  // ── Switch to edit mode ────────────────────────────────────────────────────
  /**
   * @param {any} cfg
   * @param {HTMLElement} card
   */
  function switchToEditMode(cfg, card) {
    // Destroy chart instance while editing
    const chart = chartInstances.get(cfg.id);
    if (chart) {
      chart.destroy();
      chartInstances.delete(cfg.id);
    }

    card.innerHTML = '';
    card.appendChild(editForm.buildEditForm(cfg, card, cfg.id));
  }

  // ── Add new card ───────────────────────────────────────────────────────────
  function addNewCard() {
    // A blank config for a brand-new card. Annotated so it is checked against
    // the shared protocol shape rather than inferred as a loose literal —
    // `format: ''` used to widen to `string` and silently diverge from
    // `ValueFormat | undefined`.
    /** @type {import('../../../../shared/protocol').MonitoringConfigPayload} */
    const newCfg = {
      id: '',
      folder: 'general',
      name: '',
      description: '',
      soql: '',
      labelField: '',
      valueFields: [{ field: '', label: '' }],
      chartType: 'bar',
      refreshInterval: 0,
      stacked: false,
    };

    const card = document.createElement('div');
    card.className = 'card monitoring-card';
    card.setAttribute('data-new-card', '1');

    card.appendChild(editForm.buildEditForm(newCfg, card, null));
    grid.insertBefore(card, grid.firstChild);

    // Hide no-results if shown
    noResults.style.display = 'none';
  }

  // ── Save handlers ──────────────────────────────────────────────────────────
  /**
   * @param {any} data The save reply, carrying back the `requestId` the form
   *   minted — echoed by `MessageRouter._dispatchFeatureRoute`.
   */
  function onSaveResult(data) {
    const reply = resolveReply(grid, data && data.requestId);
    const saved = data && data.config;

    // THIS save is settled here — its own terminal reply — so the button comes
    // off "Saving…" and the form stops waiting. Matched by requestId, so a
    // second form saving at the same moment is untouched: "the first card still
    // waiting" disarmed an arbitrary one, and that form's real error then
    // reached nothing.
    reply?.settle();

    // Nothing waiting on this id (the form was cancelled or rebuilt away), or a
    // reply carrying no record: fall back to the reload, so the grid still
    // reflects what was written rather than silently diverging from disk.
    if (!reply || !saved) {
      loadConfigs();
      return;
    }

    // Otherwise update this ONE card in place. Reloading the whole grid — which
    // is what this used to do — rebuilt every card from disk and tore out every
    // OTHER open edit form, unsaved edits included, with no warning.
    //
    // The reload existed for a real reason: the in-place swap before it kept
    // the card's id BY HAND, so a rename left a stale id behind, the next
    // rename sent that dead id, the host could not delete the real old file,
    // and YAML files piled up. What makes this safe is that the id now comes
    // from the reply — `saveMonitoringConfig` returns the persisted record, and
    // `MessageRouter._route` spreads the route's return value OVER the echoed
    // request precisely so the host's version wins — and is never tracked here.
    const previousId = reply.configId;
    // A rename lands the record under a new id, so the old id's auto-refresh
    // interval has to go with it; `clearAllRefreshTimers` only covered this
    // because every save used to wipe the grid.
    if (previousId && previousId !== saved.id) clearAutoRefresh(previousId);
    upsertConfig(previousId, saved);
    reply.applySaved(saved);
    // A new folder only becomes a category pill when the bar is rebuilt, and a
    // renamed one can leave the old pill behind. `render()` never fires
    // onChange, so the user's current filter selection survives.
    filterBar.render();
    applyFilters();
  }

  /**
   * Fold the persisted record into `configs`, which stays the single source the
   * filter bar, drag-order and Cancel all read.
   *
   * Keyed on the id the form was OPENED with, not on `saved.id`: the host
   * re-slugs the id from folder + name, so a rename arrives under a different
   * one and matching on the new id would leave the old entry orphaned next to
   * its replacement.
   *
   * A brand-new card (`previousId === null`) is appended, so `configs` order
   * and DOM order diverge until the next full reload — harmless, because the
   * only consumer of order is `renderAll`, which re-sorts from disk anyway.
   *
   * @param {string | null} previousId
   * @param {any} saved
   */
  function upsertConfig(previousId, saved) {
    const idx = previousId === null ? -1 : configs.findIndex((c) => c.id === previousId);
    if (idx === -1) configs.push(saved);
    else configs[idx] = saved;
  }

  /** @param {any} data */
  function onSaveError(data) {
    // Falls back to the grid-level box when nothing is waiting on this id — the
    // form was cancelled or rebuilt away — so the message is never swallowed.
    const reply = data && resolveReply(grid, data.requestId);
    if (reply) reply.fail(data.message);
    else showLoadError(data ? data.message : '');
  }

  // ── UI helpers ─────────────────────────────────────────────────────────────
  /**
   * @param {string} configId
   * @param {string} text
   */
  function setCardStatus(configId, text) {
    const card = grid.querySelector('[data-config-id="' + configId + '"]');
    if (!card) return;
    const status = card.querySelector('.monitoring-status');
    if (status) status.textContent = text;
  }

  /**
   * @param {string} configId
   * @param {string | null} msg
   */
  function setCardError(configId, msg) {
    const card = grid.querySelector('[data-config-id="' + configId + '"]');
    if (!card) return;
    const errBox = /** @type {HTMLElement} */ (card.querySelector('.error-box'));
    if (!errBox) return;
    if (msg) {
      errBox.textContent = msg;
      errBox.style.display = '';
    } else {
      errBox.style.display = 'none';
    }
  }

  // NOTE: `setEditStatus(card, text)` and `findEditCard()` used to live here, for
  // the edit-form preview alone. Both scanned the grid for the FIRST open form,
  // which is only the right one while at most one is open — the same position
  // matching the save/delete replies were moved off. `query-runner.js` now
  // resolves the owning form from the preview's own id and reads the status line
  // out of it directly, so neither helper has a caller.

  /** @param {string} configId */
  function findCardTypeSelect(configId) {
    const card = grid.querySelector('[data-config-id="' + configId + '"]');
    return /** @type {HTMLSelectElement | null} */ (
      card ? card.querySelector('.monitoring-chart-type-select') : null
    );
  }

  /**
   * View-card controls only — anything inside an open edit form is skipped.
   *
   * Those controls are rendered by Preact and the Save button's `disabled` is a
   * CONTROLLED prop, so writing it from out here is the same "external write
   * into a vdom-owned property" hazard edit-form.tsx's header calls out for the
   * preview/status/error leaves. It survived only by luck (Preact skips a prop
   * whose vdom value did not change between renders). The form owns its own
   * disabled state; an org disconnect has no business reaching into it.
   *
   * @param {boolean} disabled
   */
  function setAllButtonsDisabled(disabled) {
    const outsideForm = (/** @type {Element} */ el) => !el.closest('.monitoring-edit-form');
    grid.querySelectorAll('.monitoring-refresh-btn, .btn').forEach((btn) => {
      if (outsideForm(btn)) /** @type {HTMLButtonElement} */ (btn).disabled = disabled;
    });
    grid.querySelectorAll('.monitoring-chart-type-select').forEach((sel) => {
      if (outsideForm(sel)) /** @type {HTMLSelectElement} */ (sel).disabled = disabled;
    });
  }
})();

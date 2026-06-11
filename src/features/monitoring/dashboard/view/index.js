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
import { createEditForm } from './edit-form';
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
    setEditStatus,
    findEditCard,
    findCardTypeSelect,
  });
  const triggerQuery = queryRunner.triggerQuery;
  const refreshScheduler = createRefreshScheduler({
    getConnected: () => connected,
    getIsVisible: () => isVisible,
    triggerQuery,
  });
  const { setupAutoRefresh, clearAllRefreshTimers } = refreshScheduler;
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
    vscode,
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
    grid,
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
      switch (message.type) {
        case 'loadMonitoringConfigsResult':
          onConfigsLoaded(message.data.configs, message.data.hiddenCount || 0);
          break;
        case 'loadMonitoringConfigsError':
          showLoadError(message.data.message);
          break;
        case 'runMonitoringQueryResult':
          queryRunner.onQueryResult(message.data);
          break;
        case 'runMonitoringQueryError':
          queryRunner.onQueryError(message.data);
          break;
        case 'runMonitoringTableQueryResult':
          queryRunner.onTableQueryResult(message.data);
          break;
        case 'runMonitoringTableQueryError':
          queryRunner.onQueryError(message.data);
          break;
        case 'saveMonitoringConfigResult':
          onSaveResult();
          break;
        case 'saveMonitoringConfigError':
          onSaveError(message.data.message);
          break;
        case 'deleteMonitoringConfigResult':
          onDeleteResult(message.data);
          break;
        case 'deleteMonitoringConfigError':
          onDeleteError(message.data.message);
          break;
        case 'restoreHiddenBuiltinsResult':
          loadConfigs();
          break;
        case 'monitoringBackgroundRefreshResult': {
          const { configId, chartType, result, rowCountIncreased } = message.data || {};
          if (!configId || !result) break;
          const payload = { ...result, configId, rowCountIncreased };
          // Mirror the manual-refresh paths so the same render code runs
          if (chartType === 'table') queryRunner.onTableQueryResult(payload);
          else queryRunner.onQueryResult(payload);
          break;
        }
        case 'panelVisibilityChanged':
          isVisible = message.data.visible || false;
          // If panel became visible, resume refresh timers by re-triggering queries.
          // Skip notification-enabled configs — the host's BackgroundRefresher keeps
          // those fresh, so re-querying here would just double-fire notifications.
          if (isVisible && connected) {
            for (const cfg of configs) {
              if (cfg.refreshInterval > 0 && !hasNotifications(cfg)) {
                triggerQuery(cfg);
              }
            }
          }
          break;
      }
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
    const newCfg = {
      id: '',
      folder: 'general',
      name: '',
      description: '',
      soql: '',
      labelField: '',
      valueFields: [{ field: '', label: '', format: '' }],
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
   * Find the card that initiated the in-flight save. We can't match by
   * `savedCfg.id`: on a rename/category change the returned id differs from the
   * editing card's `data-config-id` (which still holds the OLD id), so we'd
   * never find it. The editing card is the one carrying the pending callback.
   * @param {string} prop
   */
  function findEditingCard(prop) {
    return /** @type {any} */ (
      [...grid.querySelectorAll('.card')].find((c) => /** @type {any} */ (c)[prop])
    );
  }

  function onSaveResult() {
    // Mirror onDeleteResult: re-sync the whole grid from disk after a save.
    // The previous in-place card swap maintained the card's id by hand, so any
    // drift (e.g. after a rename) left the webview holding a STALE old id; the
    // next rename then sent that dead id and the host couldn't delete the real
    // old file — files piled up. A full reload makes the rebuilt card carry the
    // persisted id, so every subsequent rename sends the correct old id.
    const card = findEditingCard('__pendingSaveResolveCleanups');
    if (card) {
      const cleanups = card.__pendingSaveResolveCleanups || [];
      cleanups.forEach((/** @type {() => void} */ fn) => fn());
    }
    loadConfigs();
  }

  /** @param {string} errMsg */
  function onSaveError(errMsg) {
    const card = findEditingCard('__pendingSaveError');
    if (card && card.__pendingSaveError) {
      card.__pendingSaveError(errMsg);
    }
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

  /**
   * @param {HTMLElement} card
   * @param {string} text
   */
  function setEditStatus(card, text) {
    const status = card.querySelector('.monitoring-status');
    if (status) status.textContent = text;
  }

  /** @param {string} configId */
  function findCardTypeSelect(configId) {
    const card = grid.querySelector('[data-config-id="' + configId + '"]');
    return /** @type {HTMLSelectElement | null} */ (
      card ? card.querySelector('.monitoring-chart-type-select') : null
    );
  }

  function findEditCard() {
    return (
      grid.querySelector('[data-new-card]') ||
      grid.querySelector('.card:has(.monitoring-edit-form)')
    );
  }

  /** @param {boolean} disabled */
  function setAllButtonsDisabled(disabled) {
    grid.querySelectorAll('.monitoring-refresh-btn, .btn').forEach((btn) => {
      /** @type {HTMLButtonElement} */ (btn).disabled = disabled;
    });
    grid.querySelectorAll('.monitoring-chart-type-select').forEach((sel) => {
      /** @type {HTMLSelectElement} */ (sel).disabled = disabled;
    });
  }
})();

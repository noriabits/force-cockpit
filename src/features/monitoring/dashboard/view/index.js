// @ts-check
// Monitoring dashboard webview orchestrator. Owns state, DOM refs, the shared
// filter bar, card shells, query dispatch, auto-refresh timers, and feature
// registration. Chart rendering, table rendering, the edit form, and drag
// reordering are delegated to focused sibling modules (each created via a
// factory that receives a ctx so it never reaches into this scope directly).
import { createCategoryFilterBar } from '../../../shared/view/category-filter-bar.js';
import { formatValue } from './format-value';
import { createChartRenderer, CHART_TYPES_WITH_CANVAS } from './chart-rendering';
import { createTableRenderer } from './table-rendering';
import { createEditForm } from './edit-form';
import { createDragOrder } from './drag-order';

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
  /** @type {Map<string, ReturnType<typeof setTimeout>>} configId → debounce timer */
  const debounceTimers = new Map();
  /** @type {Map<string, ReturnType<typeof setInterval>>} configId → auto-refresh interval */
  const refreshTimers = new Map();
  /** @type {Set<string>} configIds currently being queried */
  const pendingQueries = new Set();

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
  const editForm = createEditForm({
    labels: L,
    vscode,
    chartInstances,
    pendingQueries,
    debounceTimers,
    getConfigs: () => configs,
    nextAvailablePosition: () => dragOrder.nextAvailablePosition(),
    buildViewCard,
  });

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
            triggerQuery(cfg.id, cfg.soql, cfg.labelField, cfg.valueFields);
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
          onQueryResult(message.data);
          break;
        case 'runMonitoringQueryError':
          onQueryError(message.data);
          break;
        case 'runMonitoringTableQueryResult':
          onTableQueryResult(message.data);
          break;
        case 'runMonitoringTableQueryError':
          onQueryError(message.data);
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
          if (chartType === 'table') onTableQueryResult(payload);
          else onQueryResult(payload);
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
                triggerQuery(cfg.id, cfg.soql, cfg.labelField, cfg.valueFields);
              }
            }
          }
          break;
      }
    },
  });

  // ── Load configs ───────────────────────────────────────────────────────────
  function loadConfigs() {
    hideLoadError();
    vscode.postMessage({ type: 'loadMonitoringConfigs' });
  }

  /**
   * @param {any[]} newConfigs
   * @param {number} hiddenCount
   */
  function onConfigsLoaded(newConfigs, hiddenCount) {
    configs = newConfigs.slice().sort((a, b) => {
      const pa = a.position ?? Infinity;
      const pb = b.position ?? Infinity;
      if (pa !== pb) return pa - pb;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    renderAll(configs);
    renderRestoreHiddenLink(hiddenCount);
  }

  /** @param {number} hiddenCount */
  function renderRestoreHiddenLink(hiddenCount) {
    const existing = document.getElementById('monitoring-restore-hidden');
    if (existing) existing.remove();
    if (hiddenCount <= 0) return;
    const toolbarTop = monitoringPanel.querySelector('.monitoring-toolbar-top');
    if (!toolbarTop) return;
    const btn = document.createElement('button');
    btn.id = 'monitoring-restore-hidden';
    btn.className = 'btn btn-link monitoring-restore-hidden';
    btn.textContent =
      typeof L.btnRestoreHidden === 'function'
        ? L.btnRestoreHidden(hiddenCount)
        : `Restore hidden built-ins (${hiddenCount})`;
    btn.addEventListener('click', () => {
      vscode.postMessage({ type: 'restoreHiddenBuiltins' });
    });
    toolbarTop.insertBefore(btn, toolbarTop.firstChild);
  }

  /** @param {any} data */
  function onDeleteResult(data) {
    if (!data || data.deleted === false) return;
    loadConfigs();
  }

  /** @param {string} errMsg */
  function onDeleteError(errMsg) {
    const card = /** @type {any} */ (grid.querySelector('.card:has(.monitoring-edit-form)'));
    if (card && card.__pendingSaveError) {
      card.__pendingSaveError(errMsg);
    } else {
      showLoadError(errMsg);
    }
  }

  /** @param {string} msg */
  function showLoadError(msg) {
    loadError.textContent = msg;
    loadError.style.display = '';
  }

  function hideLoadError() {
    loadError.style.display = 'none';
    loadError.textContent = '';
  }

  // ── Render all cards ───────────────────────────────────────────────────────
  /** @param {any[]} cfgs */
  function renderAll(cfgs) {
    // Destroy existing chart instances and timers
    chartInstances.forEach((/** @type {any} */ chart) => chart.destroy());
    chartInstances.clear();
    clearAllRefreshTimers();
    pendingQueries.clear();

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
          triggerQuery(cfg.id, cfg.soql, cfg.labelField, cfg.valueFields);
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
    const cards = grid.querySelectorAll('.card[data-config-id]');
    let visibleCount = 0;
    const filtered = isFiltered();

    for (const card of cards) {
      const folder = card.getAttribute('data-folder') || '';
      const source = card.getAttribute('data-source') || '';
      const search = (card.getAttribute('data-search-text') || '').toLowerCase();

      const searchMatch = !searchQuery || search.includes(searchQuery);
      const visible = filterBar.matches({ folder, source }) && searchMatch;
      const cardEl = /** @type {HTMLElement} */ (card);
      cardEl.style.display = visible ? '' : 'none';
      if (visible) visibleCount++;

      // Hide drag handle when filtered (drag itself is gated on the handle's mousedown)
      const handle = cardEl.querySelector('.monitoring-drag-handle');
      if (handle) /** @type {HTMLElement} */ (handle).style.display = filtered ? 'none' : '';
    }

    // Also check "new card" in edit mode (no data-config-id)
    const newCard = grid.querySelector('.card[data-new-card]');
    if (newCard) visibleCount++;

    noResults.textContent = L.noResults;
    noResults.style.display = visibleCount === 0 && configs.length > 0 ? '' : 'none';
  }

  // ── Build view-mode card ───────────────────────────────────────────────────
  /** @param {any} cfg */
  function buildCardContentArea(cfg) {
    if (cfg.chartType === 'metric') {
      const metricEl = document.createElement('div');
      metricEl.className = 'monitoring-metric-display';
      return metricEl;
    } else if (cfg.chartType === 'table') {
      const tableWrapper = document.createElement('div');
      tableWrapper.className = 'monitoring-table-wrapper';
      return tableWrapper;
    } else {
      // Canvas for chart types (bar, line, pie, doughnut)
      const canvasWrapper = document.createElement('div');
      canvasWrapper.className = 'monitoring-canvas-wrapper';
      const canvas = document.createElement('canvas');
      canvas.id = 'chart-' + cfg.id.replace(/\//g, '-');
      canvasWrapper.appendChild(canvas);
      return canvasWrapper;
    }
  }

  function buildCardStatusArea() {
    const fragment = document.createDocumentFragment();
    const status = document.createElement('span');
    status.className = 'monitoring-status';
    fragment.appendChild(status);
    // Error box (must be empty in HTML per convention)
    const errorBox = document.createElement('div');
    errorBox.className = 'error-box';
    errorBox.style.display = 'none';
    fragment.appendChild(errorBox);
    return fragment;
  }

  /** @param {any} cfg */
  function buildViewCard(cfg) {
    const card = document.createElement('div');
    card.className = 'card monitoring-card';
    card.setAttribute('data-config-id', cfg.id);
    card.setAttribute('data-folder', cfg.folder);
    card.setAttribute('data-source', cfg.source || '');
    card.setAttribute('data-search-text', cfg.name + ' ' + cfg.description + ' ' + cfg.folder);
    // Drag is gated by the drag handle (see buildCardHeader). Keeping draggable=false
    // by default lets users select and copy text inside the card (e.g. table cells).
    card.draggable = false;

    dragOrder.makeCardDraggable(card, cfg.id);

    card.appendChild(buildCardHeader(cfg));

    if (cfg.description) {
      const desc = document.createElement('p');
      desc.className = 'card-description';
      desc.style.margin = '0';
      desc.textContent = cfg.description;
      card.appendChild(desc);
    }

    card.appendChild(buildCardContentArea(cfg));
    card.appendChild(buildCardStatusArea());

    if (cfg.refreshInterval > 0) {
      setupAutoRefresh(cfg);
    }

    return card;
  }

  // ── Build card header ──────────────────────────────────────────────────────
  /** @param {any} cfg */
  function buildCardHeader(cfg) {
    const header = document.createElement('div');
    header.className = 'monitoring-card-header';

    const dragHandle = document.createElement('span');
    dragHandle.className = 'monitoring-drag-handle';
    dragHandle.textContent = '⠿';
    dragHandle.title = 'Drag to reorder';
    dragHandle.addEventListener('mousedown', () => {
      const card = /** @type {HTMLElement | null} */ (header.parentElement);
      if (!card) return;
      card.draggable = true;
      // Reset draggable once the press ends, so text selection works elsewhere on the card.
      // mouseup fires on a click without drag; dragend fires after a real drag (mouseup is
      // suppressed by the browser during a drag operation, hence both listeners).
      const reset = () => {
        card.draggable = false;
        document.removeEventListener('mouseup', reset);
        document.removeEventListener('dragend', reset);
      };
      document.addEventListener('mouseup', reset);
      document.addEventListener('dragend', reset);
    });
    header.appendChild(dragHandle);

    const title = document.createElement('span');
    title.className = 'monitoring-card-title';
    title.textContent = cfg.name;
    title.title = cfg.name;
    if (cfg.source === 'private') {
      const badge = document.createElement('span');
      badge.className = 'private-badge';
      badge.textContent = L.badgePrivate;
      badge.title = L.labelPrivate;
      title.appendChild(badge);
    }

    const actions = document.createElement('div');
    actions.className = 'monitoring-card-actions';

    // Type selector only for canvas-based chart types
    if (CHART_TYPES_WITH_CANVAS.includes(cfg.chartType)) {
      actions.appendChild(buildTypeSelect(cfg));
    }

    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-secondary btn-sm';
    editBtn.textContent = L.btnEdit;
    editBtn.disabled = !connected;
    editBtn.addEventListener('click', () => {
      const card = /** @type {HTMLElement} */ (header.parentElement);
      switchToEditMode(cfg, card);
    });

    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'btn btn-primary btn-sm monitoring-refresh-btn';
    refreshBtn.textContent = L.btnRefresh;
    refreshBtn.disabled = !connected;
    refreshBtn.addEventListener('click', () => {
      triggerQuery(cfg.id, cfg.soql, cfg.labelField, cfg.valueFields);
    });

    actions.appendChild(editBtn);
    actions.appendChild(refreshBtn);
    header.appendChild(title);
    header.appendChild(actions);
    return header;
  }

  // ── Build type selector ────────────────────────────────────────────────────
  /** @param {any} cfg */
  function buildTypeSelect(cfg) {
    const typeSelect = document.createElement('select');
    typeSelect.className = 'monitoring-chart-type-select';
    for (const t of CHART_TYPES_WITH_CANVAS) {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = L.chartTypes[t];
      if (t === cfg.chartType) opt.selected = true;
      typeSelect.appendChild(opt);
    }
    typeSelect.disabled = !connected;
    typeSelect.addEventListener('change', () => {
      chartRenderer.switchChartType(cfg, typeSelect.value);
    });
    return typeSelect;
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

  // ── Query execution ────────────────────────────────────────────────────────
  /**
   * @param {string} configId
   * @param {string} soql
   * @param {string} labelField
   * @param {any[]} valueFields
   */
  function triggerQuery(configId, soql, labelField, valueFields) {
    if (!connected) return;
    // Look up the config to dispatch to the correct message type
    const cfg = configs.find((/** @type {any} */ c) => c.id === configId);
    pendingQueries.add(configId);
    setCardStatus(configId, L.statusLoading);
    setCardError(configId, null);

    if (cfg?.chartType === 'table') {
      vscode.postMessage({
        type: 'runMonitoringTableQuery',
        configId,
        configName: cfg?.name,
        soql,
        labelField,
        valueFields,
        notifyOnIncrease: cfg?.notifyOnIncrease ?? false,
      });
    } else {
      vscode.postMessage({
        type: 'runMonitoringQuery',
        configId,
        configName: cfg?.name,
        soql,
        labelField,
        valueFields,
        notifyOnIncrease: cfg?.notifyOnIncrease ?? false,
      });
    }
  }

  /** @param {any} data */
  function handlePreviewResult(data) {
    const editTypeSelect = /** @type {HTMLSelectElement | null} */ (
      grid.querySelector('.monitoring-edit-form .monitoring-chart-type-select')
    );
    const previewChartType = editTypeSelect ? editTypeSelect.value : 'bar';

    const previewCanvasEl = /** @type {HTMLElement | null} */ (
      grid.querySelector('.monitoring-preview-canvas')
    );
    const previewTableEl = /** @type {HTMLElement | null} */ (
      grid.querySelector('.monitoring-preview-table')
    );
    const previewMetricEl = /** @type {HTMLElement | null} */ (
      grid.querySelector('.monitoring-preview-metric')
    );

    if (previewChartType === 'metric') {
      if (previewMetricEl) {
        previewMetricEl.style.display = '';
        renderMetricInEl(previewMetricEl, data, null);
      }
      if (previewCanvasEl) previewCanvasEl.style.display = 'none';
      if (previewTableEl) previewTableEl.style.display = 'none';
      const editCard = findEditCard();
      if (editCard)
        setEditStatus(/** @type {HTMLElement} */ (editCard), L.statusRows(data.totalRows));
      return;
    }

    if (previewCanvasEl) previewCanvasEl.style.display = '';
    if (previewTableEl) previewTableEl.style.display = 'none';
    if (previewMetricEl) previewMetricEl.style.display = 'none';

    const previewCanvas = document.getElementById(
      'chart-preview-' + data.configId.replace('__preview__', '').replace(/\//g, '-'),
    );
    chartRenderer.renderChart(data.configId, data, previewCanvas, previewChartType, false, []);
    const editCard = findEditCard();
    if (editCard)
      setEditStatus(/** @type {HTMLElement} */ (editCard), L.statusRows(data.totalRows));
  }

  /** @param {any} data */
  function onQueryResult(data) {
    pendingQueries.delete(data.configId);

    if (data.configId.startsWith('__preview__')) {
      handlePreviewResult(data);
      return;
    }

    // Check if this config is a metric type
    const cfg = configs.find((/** @type {any} */ c) => c.id === data.configId);
    if (cfg?.chartType === 'metric') {
      renderMetric(data.configId, data, cfg);
      return;
    }

    const canvas = document.getElementById('chart-' + data.configId.replace(/\//g, '-'));
    if (!canvas) return;

    const typeSelect = findCardTypeSelect(data.configId);
    const chartType = typeSelect ? typeSelect.value : cfg?.chartType || 'bar';

    chartRenderer.renderChart(
      data.configId,
      data,
      canvas,
      chartType,
      cfg?.stacked || false,
      cfg?.valueFields || [],
    );
    setCardStatus(data.configId, L.statusRows(data.totalRows));
  }

  /** @param {any} data */
  function onQueryError(data) {
    pendingQueries.delete(data.configId);

    if (data.configId.startsWith('__preview__')) {
      const editCard = findEditCard();
      if (editCard) setEditStatus(/** @type {HTMLElement} */ (editCard), '');
      const editCardEl = grid.querySelector('.card[data-new-card], .monitoring-edit-form');
      if (editCardEl) {
        const errBox = editCardEl.querySelector('.error-box');
        if (errBox) {
          errBox.textContent = data.message;
          /** @type {HTMLElement} */ (errBox).style.display = '';
        }
      }
      return;
    }

    setCardStatus(data.configId, '');
    setCardError(data.configId, data.message);
  }

  /** @param {any} data */
  function onTableQueryResult(data) {
    pendingQueries.delete(data.configId);

    if (data.configId.startsWith('__preview__')) {
      const previewTableEl = /** @type {HTMLElement | null} */ (
        grid.querySelector('.monitoring-preview-table')
      );
      const previewCanvasEl = /** @type {HTMLElement | null} */ (
        grid.querySelector('.monitoring-preview-canvas')
      );
      const previewMetricEl = /** @type {HTMLElement | null} */ (
        grid.querySelector('.monitoring-preview-metric')
      );
      if (previewTableEl) {
        previewTableEl.style.display = '';
        tableRenderer.renderTableInEl(previewTableEl, data);
      }
      if (previewCanvasEl) previewCanvasEl.style.display = 'none';
      if (previewMetricEl) previewMetricEl.style.display = 'none';
      const editCard = findEditCard();
      if (editCard)
        setEditStatus(/** @type {HTMLElement} */ (editCard), L.statusRows(data.totalRows));
      return;
    }

    tableRenderer.renderTable(data.configId, data);
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

  // ── Metric rendering ───────────────────────────────────────────────────────
  /**
   * @param {string} configId
   * @param {any} data
   * @param {any} cfg
   */
  function renderMetric(configId, data, cfg) {
    const card = grid.querySelector('[data-config-id="' + configId + '"]');
    if (!card) return;
    const metricEl = /** @type {HTMLElement | null} */ (
      card.querySelector('.monitoring-metric-display')
    );
    if (!metricEl) return;
    renderMetricInEl(metricEl, data, cfg);
    setCardStatus(configId, L.statusRows(data.totalRows));
  }

  /**
   * @param {HTMLElement} el
   * @param {any} data
   * @param {any} cfg
   */
  function renderMetricInEl(el, data, cfg) {
    el.innerHTML = '';
    if (!data.datasets || data.datasets.length === 0 || data.datasets[0].data.length === 0) {
      const empty = document.createElement('span');
      empty.textContent = L.statusNoData;
      el.appendChild(empty);
      return;
    }
    const value = data.datasets[0].data[0];
    const fmt = cfg?.valueFields?.[0]?.format;
    const numEl = document.createElement('div');
    numEl.className = 'monitoring-metric-number';
    numEl.textContent = formatValue(value, fmt);
    const lblEl = document.createElement('div');
    lblEl.className = 'monitoring-metric-label';
    lblEl.textContent = data.datasets[0].label || '';
    el.appendChild(numEl);
    el.appendChild(lblEl);
  }

  // ── Auto-refresh ───────────────────────────────────────────────────────────
  /** Minimum auto-refresh interval in seconds to prevent API overload */
  const MIN_REFRESH_INTERVAL = 10;

  /**
   * Notification-enabled configs (any threshold OR notifyOnIncrease=true) are driven
   * by the extension host's BackgroundRefresher so they keep firing notifications
   * even when the panel is closed. Result is pushed back via
   * `monitoringBackgroundRefreshResult` and rendered through the same path as a
   * manual refresh — no webview-side timer needed.
   * @param {any} cfg
   */
  function hasNotifications(cfg) {
    if (cfg.notifyOnIncrease) return true;
    return (
      Array.isArray(cfg.valueFields) &&
      cfg.valueFields.some((/** @type {any} */ vf) => vf.threshold != null)
    );
  }

  /** @param {any} cfg */
  function setupAutoRefresh(cfg) {
    clearAutoRefresh(cfg.id);
    if (hasNotifications(cfg)) return; // host owns the timer for notification configs
    if (cfg.refreshInterval > 0) {
      // Enforce minimum interval: at least 10 seconds to prevent API rate limit issues
      const intervalMs = Math.max(cfg.refreshInterval * 1000, MIN_REFRESH_INTERVAL * 1000);
      const id = setInterval(() => {
        // Only trigger query if panel is visible and still connected
        if (connected && isVisible) triggerQuery(cfg.id, cfg.soql, cfg.labelField, cfg.valueFields);
      }, intervalMs);
      refreshTimers.set(cfg.id, id);
    }
  }

  /** @param {string} configId */
  function clearAutoRefresh(configId) {
    const id = refreshTimers.get(configId);
    if (id) {
      clearInterval(id);
      refreshTimers.delete(configId);
    }
  }

  function clearAllRefreshTimers() {
    refreshTimers.forEach((/** @type {any} */ id) => clearInterval(id));
    refreshTimers.clear();
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

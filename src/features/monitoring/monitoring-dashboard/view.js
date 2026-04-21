// @ts-check
(function () {
  const win = /** @type {any} */ (window);
  const L = win.MonitoringLabels;
  const vscode = win.__vscode;

  // ── Constants ──────────────────────────────────────────────────────────────
  const CHART_COLORS = [
    '#4ec9b0',
    '#569cd6',
    '#ce9178',
    '#dcdcaa',
    '#c586c0',
    '#9cdcfe',
    '#f44747',
    '#4fc1ff',
    '#b5cea8',
    '#d4d4d4',
  ];
  /** Chart types rendered with Chart.js canvas */
  const CHART_TYPES_WITH_CANVAS = ['bar', 'line', 'pie', 'doughnut'];
  /** All chart types including metric and table — used in edit form dropdown */
  const ALL_CHART_TYPES = [...CHART_TYPES_WITH_CANVAS, 'metric', 'table'];

  // ── State ──────────────────────────────────────────────────────────────────
  let connected = false;
  let isVisible = true; // Track panel visibility to pause auto-refresh when hidden
  let configs = /** @type {any[]} */ ([]);
  let activeFolder = 'all';
  let activeSubFolder = /** @type {string | null} */ (null);
  let activeVisibility = 'all'; // 'all' | 'shared' | 'private'
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
  /** configId currently being dragged, or null */
  let dragSrcId = /** @type {string | null} */ (null);

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
          onConfigsLoaded(message.data.configs);
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
          onSaveResult(message.data.config);
          break;
        case 'saveMonitoringConfigError':
          onSaveError(message.data.message);
          break;
        case 'panelVisibilityChanged':
          isVisible = message.data.visible || false;
          // If panel became visible, resume refresh timers by re-triggering queries
          if (isVisible && connected) {
            for (const cfg of configs) {
              if (cfg.refreshInterval > 0) {
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

  /** @param {any[]} newConfigs */
  function onConfigsLoaded(newConfigs) {
    configs = newConfigs.slice().sort((a, b) => {
      const pa = a.position ?? Infinity;
      const pb = b.position ?? Infinity;
      if (pa !== pb) return pa - pb;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    renderAll(configs);
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

    // Reset filter state
    activeVisibility = 'all';
    activeFolder = 'all';
    activeSubFolder = null;

    grid.innerHTML = '';

    buildVisibilityFilter();

    if (cfgs.length === 0) {
      noResults.textContent = L.noConfigs;
      noResults.style.display = '';
      buildPills([]);
      return;
    }

    rebuildPillsForCurrentVisibility();

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

  // ── Category pills ─────────────────────────────────────────────────────────
  /** @param {string[]} folders */
  function buildPills(folders) {
    pillsContainer.innerHTML = '';
    subPillsEl.innerHTML = '';
    subPillsEl.classList.remove('visible');

    // Only show top-level folder names (before first '/')
    const topLevel = [...new Set(folders.map((f) => f.split('/')[0]))].sort();

    const allPill = makePill(L.pillAll, 'all');
    pillsContainer.appendChild(allPill);

    for (const folder of topLevel) {
      pillsContainer.appendChild(makePill(folder, folder));
    }
  }

  /**
   * @param {string} label
   * @param {string} value
   */
  function makePill(label, value) {
    const btn = document.createElement('button');
    btn.className = 'category-pill' + (activeFolder === value ? ' active' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => {
      activeFolder = value;
      activeSubFolder = null;
      subPillsEl.innerHTML = '';
      subPillsEl.classList.remove('visible');
      pillsContainer
        .querySelectorAll('.category-pill')
        .forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');

      if (value !== 'all') {
        // Check for sub-folders among visible configs
        const visible = getVisibleConfigs();
        const subFolders = visible
          .map((/** @type {any} */ c) => c.folder)
          .filter((f) => f !== value && f.startsWith(value + '/'))
          .map((f) => f.slice(value.length + 1));
        const uniqueSubs = [...new Set(subFolders)].sort();
        if (uniqueSubs.length > 0) {
          buildSubPills(uniqueSubs);
        }
      }

      applyFilters();
    });
    return btn;
  }

  // ── Visibility filter ───────────────────────────────────────────────────────
  function buildVisibilityFilter() {
    visibilityFilterEl.innerHTML = '';
    const options = [
      { value: 'all', label: L.filterAll },
      { value: 'shared', label: L.filterShared },
      { value: 'private', label: L.filterPrivate },
    ];
    for (const opt of options) {
      const btn = document.createElement('button');
      btn.className = 'visibility-filter-btn' + (activeVisibility === opt.value ? ' active' : '');
      btn.textContent = opt.label;
      btn.addEventListener('click', () => {
        activeVisibility = opt.value;
        visibilityFilterEl
          .querySelectorAll('.visibility-filter-btn')
          .forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        activeFolder = 'all';
        activeSubFolder = null;
        rebuildPillsForCurrentVisibility();
        applyFilters();
      });
      visibilityFilterEl.appendChild(btn);
    }
  }

  function getVisibleConfigs() {
    if (activeVisibility === 'private')
      return configs.filter((/** @type {any} */ c) => c.source === 'private');
    if (activeVisibility === 'shared')
      return configs.filter((/** @type {any} */ c) => c.source !== 'private');
    return configs;
  }

  function rebuildPillsForCurrentVisibility() {
    const visible = getVisibleConfigs();
    const folders = [...new Set(visible.map((/** @type {any} */ c) => c.folder))].sort();
    buildPills(folders);
  }

  /** @param {string[]} subFolders */
  function buildSubPills(subFolders) {
    subPillsEl.innerHTML = '';
    subPillsEl.classList.add('visible');

    const allSub = document.createElement('button');
    allSub.className = 'category-pill active';
    allSub.textContent = L.pillSubAll;
    allSub.addEventListener('click', () => {
      activeSubFolder = null;
      subPillsEl.querySelectorAll('.category-pill').forEach((p) => p.classList.remove('active'));
      allSub.classList.add('active');
      applyFilters();
    });
    subPillsEl.appendChild(allSub);

    for (const sub of subFolders) {
      const btn = document.createElement('button');
      btn.className = 'category-pill';
      btn.textContent = sub;
      btn.addEventListener('click', () => {
        activeSubFolder = sub;
        subPillsEl.querySelectorAll('.category-pill').forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        applyFilters();
      });
      subPillsEl.appendChild(btn);
    }
  }

  // ── Filters ────────────────────────────────────────────────────────────────
  function isFiltered() {
    return (
      activeFolder !== 'all' ||
      activeSubFolder !== null ||
      searchQuery !== '' ||
      activeVisibility !== 'all'
    );
  }

  function applyFilters() {
    const cards = grid.querySelectorAll('.card[data-config-id]');
    let visibleCount = 0;
    const filtered = isFiltered();

    for (const card of cards) {
      const folder = card.getAttribute('data-folder') || '';
      const source = card.getAttribute('data-source') || '';
      const search = (card.getAttribute('data-search-text') || '').toLowerCase();

      // Visibility filter
      let visibilityMatch = true;
      if (activeVisibility === 'private') visibilityMatch = source === 'private';
      else if (activeVisibility === 'shared') visibilityMatch = source !== 'private';

      // Folder / sub-folder match
      let folderMatch = true;
      if (activeFolder !== 'all') {
        if (activeSubFolder) {
          folderMatch = folder === activeFolder + '/' + activeSubFolder;
        } else {
          folderMatch = folder === activeFolder || folder.startsWith(activeFolder + '/');
        }
      }

      const searchMatch = !searchQuery || search.includes(searchQuery);
      const visible = visibilityMatch && folderMatch && searchMatch;
      const cardEl = /** @type {HTMLElement} */ (card);
      cardEl.style.display = visible ? '' : 'none';
      if (visible) visibleCount++;

      // Enable/disable drag based on filter state
      /** @type {any} */ (cardEl).draggable = !filtered;
      const handle = cardEl.querySelector('.monitoring-drag-handle');
      if (handle) /** @type {HTMLElement} */ (handle).style.display = filtered ? 'none' : '';
    }

    // Also check "new card" in edit mode (no data-config-id)
    const newCard = grid.querySelector('.card[data-new-card]');
    if (newCard) visibleCount++;

    noResults.textContent = L.noResults;
    noResults.style.display = visibleCount === 0 && configs.length > 0 ? '' : 'none';
  }

  // ── Card ordering ───────────────────────────────────────────────────────────
  function saveCardOrder() {
    const allCards = Array.from(grid.querySelectorAll('.card[data-config-id]'));
    const positions = allCards.map((card, idx) => ({
      id: card.getAttribute('data-config-id') || '',
      position: idx,
      source: card.getAttribute('data-source') || '',
    }));
    for (const { id, position } of positions) {
      const cfg = configs.find((/** @type {any} */ c) => c.id === id);
      if (cfg) cfg.position = position;
    }
    vscode.postMessage({ type: 'saveMonitoringPositions', positions });
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
    card.draggable = true;

    card.addEventListener('dragstart', (e) => {
      if (grid.querySelector('.monitoring-edit-form')) {
        e.preventDefault();
        return;
      }
      dragSrcId = cfg.id;
      card.classList.add('monitoring-card--dragging');
      /** @type {DataTransfer} */ (e.dataTransfer).effectAllowed = 'move';
    });

    card.addEventListener('dragend', () => {
      card.classList.remove('monitoring-card--dragging');
      dragSrcId = null;
      grid
        .querySelectorAll('.monitoring-card--drag-over-before, .monitoring-card--drag-over-after')
        .forEach((el) => {
          el.classList.remove(
            'monitoring-card--drag-over-before',
            'monitoring-card--drag-over-after',
          );
        });
    });

    card.addEventListener('dragover', (e) => {
      if (!dragSrcId || dragSrcId === cfg.id) return;
      e.preventDefault();
      /** @type {DataTransfer} */ (e.dataTransfer).dropEffect = 'move';
      const rect = card.getBoundingClientRect();
      const isBefore = /** @type {DragEvent} */ (e).clientY < rect.top + rect.height / 2;
      grid
        .querySelectorAll('.monitoring-card--drag-over-before, .monitoring-card--drag-over-after')
        .forEach((el) => {
          el.classList.remove(
            'monitoring-card--drag-over-before',
            'monitoring-card--drag-over-after',
          );
        });
      card.classList.add(
        isBefore ? 'monitoring-card--drag-over-before' : 'monitoring-card--drag-over-after',
      );
    });

    card.addEventListener('dragleave', () => {
      card.classList.remove(
        'monitoring-card--drag-over-before',
        'monitoring-card--drag-over-after',
      );
    });

    card.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!dragSrcId || dragSrcId === cfg.id) return;
      const dragCard = /** @type {HTMLElement | null} */ (
        grid.querySelector(`.card[data-config-id="${dragSrcId}"]`)
      );
      if (!dragCard) return;
      const rect = card.getBoundingClientRect();
      const isBefore = /** @type {DragEvent} */ (e).clientY < rect.top + rect.height / 2;
      card.classList.remove(
        'monitoring-card--drag-over-before',
        'monitoring-card--drag-over-after',
      );
      if (isBefore) {
        grid.insertBefore(dragCard, card);
      } else {
        grid.insertBefore(dragCard, card.nextSibling);
      }
      saveCardOrder();
    });

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
      const chart = chartInstances.get(cfg.id);
      if (!chart) return;
      const newType = typeSelect.value;
      const isMultiColor = newType === 'pie' || newType === 'doughnut';
      chart.config.type = newType;
      // Re-color datasets: always one color per label
      const labels = /** @type {any[]} */ (chart.data.labels ?? []);
      const perLabelColors = labels.map(
        (/** @type {any} */ _l, /** @type {number} */ idx) =>
          CHART_COLORS[idx % CHART_COLORS.length],
      );
      chart.data.datasets.forEach((/** @type {any} */ ds) => {
        ds.backgroundColor = perLabelColors;
        ds.borderColor = perLabelColors;
        ds.pointBackgroundColor = perLabelColors;
        ds.pointBorderColor = perLabelColors;
      });
      // Show legend for multi-colour charts or multi-dataset charts
      if (chart.options.plugins && chart.options.plugins.legend) {
        chart.options.plugins.legend.display = chart.data.datasets.length > 1 || isMultiColor;
      }
      // Restore or clear scales: pie/doughnut have no axes; bar/line need x+y
      const stacked = cfg.stacked || false;
      chart.options.scales = isMultiColor
        ? {}
        : {
            x: {
              stacked,
              ticks: { color: '#aaaaaa', maxRotation: 45 },
              grid: { color: '#333333' },
            },
            y: { stacked, ticks: { color: '#aaaaaa' }, grid: { color: '#333333' } },
          };
      chart.update();
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
    card.appendChild(buildEditForm(cfg, card, cfg.id));
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

    card.appendChild(buildEditForm(newCfg, card, null));
    grid.insertBefore(card, grid.firstChild);

    // Hide no-results if shown
    noResults.style.display = 'none';
  }

  // ── Build edit form ────────────────────────────────────────────────────────
  /**
   * @param {any} cfg
   * @param {any} card
   * @param {string | null} configId
   */
  function buildEditForm(cfg, card, configId) {
    const form = document.createElement('div');
    form.className = 'monitoring-edit-form';
    /** @type {Array<() => void>} */
    const cleanups = []; // Track cleanup functions for form teardown

    // Name
    form.appendChild(
      makeFormRow(
        L.labelName,
        makeInput('text', cfg.name, L.placeholderName, 'monitoring-edit-name'),
      ),
    );

    // Category
    const { element: folderCombobox, cleanup: folderCleanup } = makeFolderCombobox(cfg.folder);
    cleanups.push(folderCleanup);
    form.appendChild(makeFormRow(L.labelCategory, folderCombobox));

    // Description
    form.appendChild(
      makeFormRow(
        L.labelDescription,
        makeInput('text', cfg.description, L.placeholderDescription, 'monitoring-edit-desc'),
      ),
    );

    // SOQL
    const soqlArea = document.createElement('textarea');
    soqlArea.className = 'text-input monitoring-soql-input';
    soqlArea.value = cfg.soql;
    soqlArea.placeholder = L.placeholderSoql;
    soqlArea.id = 'monitoring-edit-soql';
    form.appendChild(makeFormRow(L.labelSoql, soqlArea));

    // Label field (hidden for metric type)
    const labelFieldInput = makeInput(
      'text',
      cfg.labelField,
      L.placeholderLabelField,
      'monitoring-edit-labelfield',
    );
    const labelFieldRow = makeFormRow(L.labelLabelField, labelFieldInput);
    form.appendChild(labelFieldRow);

    // Value fields
    const vfContainer = document.createElement('div');
    vfContainer.className = 'monitoring-value-fields';
    for (const vf of cfg.valueFields) {
      vfContainer.appendChild(
        makeValueFieldRow(
          vf.field,
          vf.label,
          vf.format || '',
          vf.threshold ?? null,
          vf.thresholdCondition || 'above',
          vfContainer,
        ),
      );
    }
    const addVfBtn = document.createElement('button');
    addVfBtn.className = 'btn btn-secondary btn-sm';
    addVfBtn.textContent = L.btnAddValueField;
    addVfBtn.style.alignSelf = 'flex-start';
    addVfBtn.addEventListener('click', () => {
      vfContainer.insertBefore(makeValueFieldRow('', '', '', null, 'above', vfContainer), addVfBtn);
    });
    vfContainer.appendChild(addVfBtn);
    form.appendChild(makeFormRow(L.labelValueFields, vfContainer));

    // Chart type
    const chartTypeSelect = document.createElement('select');
    chartTypeSelect.className = 'text-input monitoring-chart-type-select';
    chartTypeSelect.style.width = 'auto';
    for (const t of ALL_CHART_TYPES) {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = L.chartTypes[t];
      if (t === cfg.chartType) opt.selected = true;
      chartTypeSelect.appendChild(opt);
    }
    form.appendChild(makeFormRow(L.labelChartType, chartTypeSelect));

    // Stacked checkbox (bar/line only)
    const stackedCheckbox = document.createElement('input');
    stackedCheckbox.type = 'checkbox';
    stackedCheckbox.id = 'monitoring-edit-stacked';
    stackedCheckbox.checked = cfg.stacked || false;
    const stackedRow = makeFormRow(L.labelStacked, stackedCheckbox);
    stackedRow.classList.add('monitoring-form-row--inline');
    form.appendChild(stackedRow);

    // Refresh interval
    const intervalInput = makeInput(
      'number',
      String(cfg.refreshInterval ?? 0),
      '0',
      'monitoring-edit-interval',
    );
    intervalInput.min = '0';
    intervalInput.style.width = '80px';
    form.appendChild(makeFormRow(L.labelRefreshInterval, intervalInput));

    // Private checkbox
    const privateCheckbox = document.createElement('input');
    privateCheckbox.type = 'checkbox';
    privateCheckbox.id = 'monitoring-edit-private';
    privateCheckbox.checked = cfg.source === 'private';
    const privateRow = makeFormRow(L.labelPrivate, privateCheckbox);
    privateRow.classList.add('monitoring-form-row--inline');
    form.appendChild(privateRow);

    // Preview area — contains canvas, table placeholder, and metric placeholder
    const previewWrapper = document.createElement('div');
    previewWrapper.className = 'monitoring-preview-wrapper monitoring-canvas-wrapper';

    const previewCanvasId = 'chart-preview-' + (configId || 'new').replace(/\//g, '-');
    const previewCanvas = document.createElement('canvas');
    previewCanvas.id = previewCanvasId;
    previewCanvas.className = 'monitoring-preview-canvas';
    previewWrapper.appendChild(previewCanvas);

    const previewTableWrapper = document.createElement('div');
    previewTableWrapper.className = 'monitoring-table-wrapper monitoring-preview-table';
    previewTableWrapper.style.display = 'none';
    previewWrapper.appendChild(previewTableWrapper);

    const previewMetricEl = document.createElement('div');
    previewMetricEl.className = 'monitoring-metric-display monitoring-preview-metric';
    previewMetricEl.style.display = 'none';
    previewWrapper.appendChild(previewMetricEl);

    form.appendChild(previewWrapper);

    // Status / error
    const statusEl = document.createElement('span');
    statusEl.className = 'monitoring-status';
    form.appendChild(statusEl);

    const errorBox = document.createElement('div');
    errorBox.className = 'error-box';
    errorBox.style.display = 'none';
    form.appendChild(errorBox);

    // Actions row
    const actionsRow = document.createElement('div');
    actionsRow.className = 'monitoring-edit-actions';

    const previewBtn = document.createElement('button');
    previewBtn.className = 'btn btn-secondary';
    previewBtn.textContent = L.btnPreview;

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-primary';
    saveBtn.textContent = L.btnSave;

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-secondary';
    cancelBtn.textContent = L.btnCancel;

    actionsRow.appendChild(previewBtn);
    actionsRow.appendChild(saveBtn);
    actionsRow.appendChild(cancelBtn);
    form.appendChild(actionsRow);

    // ── Visibility helpers ──
    function updateFormVisibility() {
      const type = chartTypeSelect.value;
      // Hide label field for metric (not needed)
      labelFieldRow.style.display = type === 'metric' ? 'none' : '';
      // Show stacked only for bar / line
      stackedRow.style.display = type === 'bar' || type === 'line' ? '' : 'none';
    }

    updateFormVisibility();
    chartTypeSelect.addEventListener('change', updateFormVisibility);

    // ── Helpers used by event handlers ──
    function readScalarFormFields() {
      const nameVal = /** @type {HTMLInputElement} */ (
        form.querySelector('#monitoring-edit-name')
      ).value.trim();
      const folderVal =
        /** @type {HTMLInputElement} */ (
          form.querySelector('#monitoring-edit-folder')
        ).value.trim() || 'general';
      const descVal = /** @type {HTMLInputElement} */ (
        form.querySelector('#monitoring-edit-desc')
      ).value.trim();
      const soqlVal = /** @type {HTMLTextAreaElement} */ (
        form.querySelector('#monitoring-edit-soql')
      ).value.trim();
      const labelFieldVal = /** @type {HTMLInputElement} */ (
        form.querySelector('#monitoring-edit-labelfield')
      ).value.trim();
      const intervalVal =
        parseInt(
          /** @type {HTMLInputElement} */ (form.querySelector('#monitoring-edit-interval')).value,
          10,
        ) || 0;
      const stackedVal =
        /** @type {HTMLInputElement} */ (form.querySelector('#monitoring-edit-stacked'))?.checked ||
        false;
      return { nameVal, folderVal, descVal, soqlVal, labelFieldVal, intervalVal, stackedVal };
    }

    function readValueFields() {
      const vfRows = vfContainer.querySelectorAll('.monitoring-value-field-row');
      const valueFields = [];
      for (const row of vfRows) {
        const inputs = row.querySelectorAll('input');
        const formatSel = /** @type {HTMLSelectElement | null} */ (
          row.querySelector('.monitoring-vf-format-select')
        );
        const conditionSel = /** @type {HTMLSelectElement | null} */ (
          row.querySelector('.monitoring-vf-condition-select')
        );
        const field = inputs[0].value.trim();
        const label = inputs[1].value.trim();
        const format = formatSel ? formatSel.value : '';
        const thresholdRaw = inputs[2] ? inputs[2].value.trim() : '';
        const threshold = thresholdRaw !== '' ? Number(thresholdRaw) : undefined;
        const thresholdCondition = conditionSel ? conditionSel.value : 'above';
        if (field) {
          /** @type {any} */
          const vf = { field, label: label || field };
          if (format) vf.format = format;
          if (threshold != null && !isNaN(threshold)) {
            vf.threshold = threshold;
            vf.thresholdCondition = thresholdCondition;
          }
          valueFields.push(vf);
        }
      }
      return valueFields;
    }

    function readFormConfig() {
      const { nameVal, folderVal, descVal, soqlVal, labelFieldVal, intervalVal, stackedVal } =
        readScalarFormFields();
      const valueFields = readValueFields();
      return {
        id: configId || '',
        folder: folderVal,
        name: nameVal,
        description: descVal,
        soql: soqlVal,
        labelField: labelFieldVal,
        valueFields: valueFields.length > 0 ? valueFields : cfg.valueFields,
        chartType: chartTypeSelect.value,
        refreshInterval: intervalVal,
        stacked: stackedVal,
      };
    }

    function triggerPreview() {
      const liveCfg = readFormConfig();
      const isMetric = liveCfg.chartType === 'metric';
      const isTable = liveCfg.chartType === 'table';

      if (!liveCfg.soql || liveCfg.valueFields.length === 0) return;
      if (!isMetric && !liveCfg.labelField) return;

      statusEl.textContent = L.statusLoading;
      errorBox.style.display = 'none';

      const previewId = '__preview__' + (configId || 'new');
      pendingQueries.add(previewId);

      if (isTable) {
        vscode.postMessage({
          type: 'runMonitoringTableQuery',
          configId: previewId,
          configName: liveCfg.name,
          soql: liveCfg.soql,
          labelField: liveCfg.labelField,
          valueFields: liveCfg.valueFields,
        });
      } else {
        vscode.postMessage({
          type: 'runMonitoringQuery',
          configId: previewId,
          configName: liveCfg.name,
          soql: liveCfg.soql,
          labelField: liveCfg.labelField,
          valueFields: liveCfg.valueFields,
        });
      }
    }

    // Debounced auto-preview on SOQL change
    soqlArea.addEventListener('input', () => {
      const timerId = debounceTimers.get('__preview__');
      if (timerId) clearTimeout(timerId);
      debounceTimers.set('__preview__', setTimeout(triggerPreview, 800));
    });

    // Chart type change → instant update on preview chart (canvas types only)
    chartTypeSelect.addEventListener('change', () => {
      const previewId = '__preview__' + (configId || 'new');
      const chart = chartInstances.get(previewId);
      if (chart) {
        chart.config.type = chartTypeSelect.value;
        chart.update();
      }
    });

    previewBtn.addEventListener('click', triggerPreview);

    saveBtn.addEventListener('click', () => {
      const liveCfg = readFormConfig();
      if (!liveCfg.name) {
        errorBox.textContent = 'Name is required.';
        errorBox.style.display = '';
        return;
      }
      if (!liveCfg.soql) {
        errorBox.textContent = 'SOQL query is required.';
        errorBox.style.display = '';
        return;
      }
      if (!liveCfg.labelField && liveCfg.chartType !== 'metric') {
        errorBox.textContent = 'Label field is required.';
        errorBox.style.display = '';
        return;
      }
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
      card.__pendingSaveResolve = (/** @type {any} */ savedCfg) => {
        const savedCleanups = card.__pendingSaveResolveCleanups || [];
        savedCleanups.forEach((/** @type {() => void} */ cleanup) => cleanup());
        configs = configs.filter((/** @type {any} */ c) => c.id !== cfg.id);
        configs.push(savedCfg);
        const newCard = buildViewCard(savedCfg);
        card.replaceWith(newCard);
        triggerQuery(savedCfg.id, savedCfg.soql, savedCfg.labelField, savedCfg.valueFields);
        rebuildPillsForCurrentVisibility();
        applyFilters();
      };
      card.__pendingSaveError = (/** @type {string} */ errMsg) => {
        saveBtn.disabled = false;
        saveBtn.textContent = L.btnSave;
        errorBox.textContent = errMsg;
        errorBox.style.display = '';
      };
      // On successful save, the __pendingSaveResolve callback will replace the card and trigger cleanup
      // Set a flag so cleanup is called after the card is replaced
      card.__pendingSaveResolveCleanups = /** @type {Array<() => void>} */ (cleanups);
      const isPrivate =
        /** @type {HTMLInputElement | null} */ (form.querySelector('#monitoring-edit-private'))
          ?.checked || false;
      vscode.postMessage({ type: 'saveMonitoringConfig', config: liveCfg, isPrivate });
    });

    cancelBtn.addEventListener('click', () => {
      cleanups.forEach((/** @type {() => void} */ cleanup) => cleanup());
      if (configId) {
        // Revert to view mode with original config
        const originalCfg = configs.find((/** @type {any} */ c) => c.id === configId) || cfg;
        const newCard = buildViewCard(originalCfg);
        card.replaceWith(newCard);
      } else {
        // New card — just remove it
        card.remove();
      }
    });

    return form;
  }

  // ── Form helpers ───────────────────────────────────────────────────────────
  /**
   * @param {string} labelText
   * @param {HTMLElement} inputEl
   */
  function makeFormRow(labelText, inputEl) {
    const row = document.createElement('div');
    row.className = 'monitoring-form-row';
    const label = document.createElement('label');
    label.className = 'monitoring-form-label';
    label.textContent = labelText;
    row.appendChild(label);
    row.appendChild(inputEl);
    return row;
  }

  /**
   * @param {string} type
   * @param {string} value
   * @param {string} placeholder
   * @param {string} id
   * @returns {HTMLInputElement}
   */
  function makeInput(type, value, placeholder, id) {
    const input = document.createElement('input');
    input.type = type;
    input.className = 'text-input';
    input.value = value || '';
    input.placeholder = placeholder || '';
    if (id) input.id = id;
    return input;
  }

  /**
   * Build a combobox for the Category field (text input + dropdown of existing folders).
   * @param {string} currentValue
   * @returns {{ element: HTMLDivElement, cleanup: () => void }}
   */
  function makeFolderCombobox(currentValue) {
    const wrapper = document.createElement('div');
    wrapper.className = 'monitoring-folder-combobox';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'text-input';
    input.value = currentValue || '';
    input.placeholder = L.placeholderCategory;
    input.id = 'monitoring-edit-folder';
    input.autocomplete = 'off';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'monitoring-folder-toggle';
    toggle.tabIndex = -1;
    toggle.innerHTML = '&#9662;';

    const dropdown = document.createElement('div');
    dropdown.className = 'monitoring-folder-dropdown';

    wrapper.appendChild(input);
    wrapper.appendChild(toggle);
    wrapper.appendChild(dropdown);

    // Populate dropdown from existing config folders
    const folders = [...new Set(configs.map((/** @type {any} */ c) => c.folder))].sort();
    for (const folder of folders) {
      const opt = document.createElement('div');
      opt.className = 'monitoring-folder-option';
      opt.textContent = folder;
      opt.addEventListener('mousedown', (e) => {
        e.preventDefault();
        input.value = folder;
        dropdown.classList.remove('open');
      });
      dropdown.appendChild(opt);
    }

    // Toggle button
    toggle.addEventListener('click', () => {
      if (dropdown.classList.contains('open')) {
        dropdown.classList.remove('open');
      } else if (dropdown.children.length > 0) {
        dropdown.classList.add('open');
      }
      input.focus();
    });

    // Click-outside close — track listener for cleanup
    const clickHandler = (/** @type {MouseEvent} */ e) => {
      if (!wrapper.contains(/** @type {Node} */ (e.target))) {
        dropdown.classList.remove('open');
      }
    };
    document.addEventListener('click', clickHandler);

    return {
      element: wrapper,
      cleanup: () => document.removeEventListener('click', clickHandler),
    };
  }

  /** @param {string} currentFormat @returns {HTMLSelectElement} */
  function buildFormatSelect(currentFormat) {
    const formatSelect = document.createElement('select');
    formatSelect.className = 'monitoring-vf-format-select';
    formatSelect.title = L.labelValueFieldFormat;
    for (const [val, lbl] of Object.entries(L.formatOptions)) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = /** @type {string} */ (lbl);
      if (val === (currentFormat || '')) opt.selected = true;
      formatSelect.appendChild(opt);
    }
    return formatSelect;
  }

  /**
   * @param {number | null} threshold
   * @param {string} thresholdCondition
   * @returns {{ thresholdInput: HTMLInputElement, conditionSelect: HTMLSelectElement }}
   */
  function buildThresholdGroup(threshold, thresholdCondition) {
    const thresholdInput = /** @type {HTMLInputElement} */ (
      makeInput('number', threshold != null ? String(threshold) : '', L.placeholderThreshold, '')
    );
    thresholdInput.className = 'text-input monitoring-vf-threshold-input';
    thresholdInput.title = L.placeholderThreshold;
    thresholdInput.min = '0';

    const conditionSelect = document.createElement('select');
    conditionSelect.className = 'monitoring-vf-condition-select';
    conditionSelect.title = L.labelThresholdCondition;
    for (const [val, lbl] of Object.entries(L.conditionOptions)) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = /** @type {string} */ (lbl);
      if (val === (thresholdCondition || 'above')) opt.selected = true;
      conditionSelect.appendChild(opt);
    }

    return { thresholdInput, conditionSelect };
  }

  /**
   * @param {string} field
   * @param {string} label
   * @param {string} format
   * @param {number | null} threshold
   * @param {string} thresholdCondition
   * @param {HTMLElement} container
   */
  function makeValueFieldRow(field, label, format, threshold, thresholdCondition, container) {
    const row = document.createElement('div');
    row.className = 'monitoring-value-field-row';

    const fieldInput = makeInput('text', field, L.placeholderValueFieldApi, '');
    fieldInput.title = L.labelValueFieldApi;

    const labelInput = makeInput('text', label, L.placeholderValueFieldLabel, '');
    labelInput.title = L.labelValueFieldLabel;

    const { thresholdInput, conditionSelect } = buildThresholdGroup(threshold, thresholdCondition);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'monitoring-remove-vf-btn';
    removeBtn.textContent = L.btnRemoveValueField;
    removeBtn.title = 'Remove';
    removeBtn.addEventListener('click', () => {
      // Keep at least one row
      const rows = container.querySelectorAll('.monitoring-value-field-row');
      if (rows.length > 1) row.remove();
    });

    row.appendChild(fieldInput);
    row.appendChild(labelInput);
    row.appendChild(buildFormatSelect(format));
    row.appendChild(thresholdInput);
    row.appendChild(conditionSelect);
    row.appendChild(removeBtn);
    return row;
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
      });
    } else {
      vscode.postMessage({
        type: 'runMonitoringQuery',
        configId,
        configName: cfg?.name,
        soql,
        labelField,
        valueFields,
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
    renderChart(data.configId, data, previewCanvas, previewChartType, false, []);
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

    renderChart(
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
        renderTableInEl(previewTableEl, data);
      }
      if (previewCanvasEl) previewCanvasEl.style.display = 'none';
      if (previewMetricEl) previewMetricEl.style.display = 'none';
      const editCard = findEditCard();
      if (editCard)
        setEditStatus(/** @type {HTMLElement} */ (editCard), L.statusRows(data.totalRows));
      return;
    }

    renderTable(data.configId, data);
  }

  // ── Save handlers ──────────────────────────────────────────────────────────
  /** @param {any} savedCfg */
  function onSaveResult(savedCfg) {
    const card = /** @type {any} */ (
      grid.querySelector('[data-config-id="' + savedCfg.id + '"], [data-new-card]')
    );
    if (card && card.__pendingSaveResolve) {
      card.__pendingSaveResolve(savedCfg);
    }
  }

  /** @param {string} errMsg */
  function onSaveError(errMsg) {
    const card = /** @type {any} */ (
      grid.querySelector('[data-new-card]') ||
        grid.querySelector('.card:has(.monitoring-edit-form)')
    );
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

  // ── Table rendering ────────────────────────────────────────────────────────
  /**
   * @param {string} configId
   * @param {any} data
   */
  function renderTable(configId, data) {
    const card = grid.querySelector('[data-config-id="' + configId + '"]');
    if (!card) return;
    const wrapper = /** @type {HTMLElement | null} */ (
      card.querySelector('.monitoring-table-wrapper')
    );
    if (!wrapper) return;
    renderTableInEl(wrapper, data);
    setCardStatus(configId, L.statusRows(data.totalRows));
  }

  /**
   * @param {HTMLElement} wrapper
   * @param {any} data
   */
  function renderTableInEl(wrapper, data) {
    wrapper.innerHTML = '';
    if (!data.rows || data.rows.length === 0) {
      const empty = document.createElement('span');
      empty.style.padding = '8px';
      empty.style.display = 'block';
      empty.style.color = 'var(--vscode-descriptionForeground)';
      empty.textContent = L.statusNoData;
      wrapper.appendChild(empty);
      return;
    }

    const table = document.createElement('table');
    table.className = 'monitoring-table';

    let sortCol = -1;
    let sortAsc = true;

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    data.columnLabels.forEach((/** @type {string} */ lbl, /** @type {number} */ i) => {
      const th = document.createElement('th');
      th.className = 'monitoring-table-th';
      th.textContent = lbl;
      th.addEventListener('click', () => {
        if (sortCol === i) {
          sortAsc = !sortAsc;
        } else {
          sortCol = i;
          sortAsc = true;
        }
        sortAndRenderRows(tbody, data.rows, sortCol, sortAsc);
      });
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    table.appendChild(tbody);
    wrapper.appendChild(table);

    sortAndRenderRows(tbody, data.rows, sortCol, sortAsc);
  }

  /**
   * @param {HTMLElement} tbody
   * @param {string[][]} rows
   * @param {number} sortCol
   * @param {boolean} sortAsc
   */
  function sortAndRenderRows(tbody, rows, sortCol, sortAsc) {
    const sorted =
      sortCol >= 0
        ? [...rows].sort((a, b) => {
            const va = a[sortCol] ?? '';
            const vb = b[sortCol] ?? '';
            const na = Number(va);
            const nb = Number(vb);
            if (!isNaN(na) && !isNaN(nb)) return sortAsc ? na - nb : nb - na;
            return sortAsc
              ? String(va).localeCompare(String(vb))
              : String(vb).localeCompare(String(va));
          })
        : rows;

    tbody.innerHTML = '';
    for (const row of sorted) {
      const tr = document.createElement('tr');
      for (const cell of row) {
        const td = document.createElement('td');
        td.className = 'monitoring-table-td';
        td.textContent = cell;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
  }

  // ── Chart rendering ────────────────────────────────────────────────────────
  /**
   * @param {any[]} labels
   * @param {any[]} datasets
   * @returns {any[]}
   */
  function buildChartDatasets(labels, datasets) {
    const perLabelColors = labels.map(
      (/** @type {any} */ _l, /** @type {number} */ idx) => CHART_COLORS[idx % CHART_COLORS.length],
    );
    return datasets.map((/** @type {any} */ ds) => ({
      label: ds.label,
      data: ds.data,
      backgroundColor: perLabelColors,
      borderColor: perLabelColors,
      pointBackgroundColor: perLabelColors,
      pointBorderColor: perLabelColors,
      borderWidth: 1,
    }));
  }

  /**
   * @param {boolean} stacked
   * @param {any[]} valueFields
   * @param {boolean} isMultiColor
   * @returns {any}
   */
  function buildChartScales(stacked, valueFields, isMultiColor) {
    if (isMultiColor) return {};
    return {
      x: {
        stacked: stacked || false,
        ticks: { color: '#aaaaaa', maxRotation: 45 },
        grid: { color: '#333333' },
      },
      y: {
        stacked: stacked || false,
        ticks: {
          color: '#aaaaaa',
          callback: (/** @type {any} */ value) => formatValue(value, valueFields?.[0]?.format),
        },
        grid: { color: '#333333' },
      },
    };
  }

  /**
   * @param {any[]} valueFields
   * @returns {any}
   */
  function buildChartTooltip(valueFields) {
    return {
      label: (/** @type {any} */ ctx) => {
        const vf = valueFields?.[ctx.datasetIndex];
        const raw = ctx.parsed?.y ?? ctx.parsed;
        const formatted = formatValue(raw, vf?.format);
        return ctx.dataset.label ? ctx.dataset.label + ': ' + formatted : formatted;
      },
    };
  }

  /**
   * @param {string} configId
   * @param {any} data
   * @param {HTMLElement | null} canvas
   * @param {string} chartType
   * @param {boolean} stacked
   * @param {any[]} valueFields
   */
  function renderChart(configId, data, canvas, chartType, stacked, valueFields) {
    if (!canvas || !win.Chart) return;

    const existing = chartInstances.get(configId);
    if (existing) {
      existing.destroy();
      chartInstances.delete(configId);
    }

    if (!data.labels || data.labels.length === 0) {
      setCardStatus(configId, L.statusNoData);
      return;
    }

    const type = chartType || 'bar';
    const isMultiColor = type === 'pie' || type === 'doughnut';
    const datasets = buildChartDatasets(data.labels, data.datasets);

    const chart = new win.Chart(canvas, {
      type,
      data: { labels: data.labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: data.datasets.length > 1 || isMultiColor,
            labels: { color: '#cccccc' },
          },
          tooltip: { callbacks: buildChartTooltip(valueFields) },
        },
        scales: buildChartScales(stacked, valueFields, isMultiColor),
      },
    });

    chartInstances.set(configId, chart);
  }

  // ── Format value ───────────────────────────────────────────────────────────
  /**
   * @param {any} value
   * @param {string | undefined} format
   * @returns {string}
   */
  function formatValue(value, format) {
    const num = Number(value);
    if (isNaN(num)) return String(value ?? '');
    if (format === 'currency') {
      return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    if (format === 'percent') {
      return num.toFixed(1) + '%';
    }
    if (Number.isInteger(num)) return num.toLocaleString();
    return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  // ── Auto-refresh ───────────────────────────────────────────────────────────
  /** Minimum auto-refresh interval in seconds to prevent API overload */
  const MIN_REFRESH_INTERVAL = 10;

  /** @param {any} cfg */
  function setupAutoRefresh(cfg) {
    clearAutoRefresh(cfg.id);
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

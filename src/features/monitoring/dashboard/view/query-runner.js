// @ts-check
// Query dispatch + result/error routing for the monitoring dashboard. Posts the
// SOQL run messages to the host and renders the responses (chart, metric, or
// table) into either the live card or the edit-form preview area. Owns no state
// of its own — the grid, config getter, renderers and the card-status helpers
// are injected via ctx so it never reaches into the orchestrator's scope.
//
// `triggerQuery(cfg)` takes the full config (every call site already holds it).
// The host's background-refresh path (`monitoringBackgroundRefreshResult`) is
// routed through the same `onQueryResult` / `onTableQueryResult` returned here.
import { extractMetric } from './metric-value';

/**
 * @typedef {Object} QueryRunnerCtx
 * @property {any} labels
 * @property {{ postMessage: (msg: any) => void }} vscode
 * @property {HTMLElement} grid
 * @property {() => boolean} getConnected
 * @property {() => any[]} getConfigs
 * @property {{ renderChart: Function }} chartRenderer
 * @property {{ renderTable: Function, renderTableInEl: Function }} tableRenderer
 * @property {(configId: string, text: string) => void} setCardStatus
 * @property {(configId: string, msg: string | null) => void} setCardError
 * @property {(card: HTMLElement, text: string) => void} setEditStatus
 * @property {() => Element | null} findEditCard
 * @property {(configId: string) => HTMLSelectElement | null} findCardTypeSelect
 */

/**
 * @param {QueryRunnerCtx} ctx
 */
export function createQueryRunner(ctx) {
  const {
    labels: L,
    vscode,
    grid,
    getConnected,
    getConfigs,
    chartRenderer,
    tableRenderer,
    setCardStatus,
    setCardError,
    setEditStatus,
    findEditCard,
    findCardTypeSelect,
  } = ctx;

  // ── Query execution ────────────────────────────────────────────────────────
  /** @param {any} cfg */
  function triggerQuery(cfg) {
    if (!getConnected()) return;
    const configId = cfg.id;
    setCardStatus(configId, L.statusLoading);
    setCardError(configId, null);

    const type = cfg.chartType === 'table' ? 'runMonitoringTableQuery' : 'runMonitoringQuery';
    vscode.postMessage({
      type,
      configId,
      configName: cfg.name,
      soql: cfg.soql,
      labelField: cfg.labelField,
      valueFields: cfg.valueFields,
      notifyOnIncrease: cfg.notifyOnIncrease ?? false,
    });
  }

  // ── Preview routing ──────────────────────────────────────────────────────
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

  // ── Chart / metric result ────────────────────────────────────────────────
  /** @param {any} data */
  function onQueryResult(data) {
    if (data.configId.startsWith('__preview__')) {
      handlePreviewResult(data);
      return;
    }

    // Check if this config is a metric type
    const cfg = getConfigs().find((/** @type {any} */ c) => c.id === data.configId);
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

  // ── Table result ───────────────────────────────────────────────────────────
  /** @param {any} data */
  function onTableQueryResult(data) {
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
    const metric = extractMetric(data, cfg?.valueFields);
    if (metric.empty) {
      const empty = document.createElement('span');
      empty.textContent = L.statusNoData;
      el.appendChild(empty);
      return;
    }
    const numEl = document.createElement('div');
    numEl.className = 'monitoring-metric-number';
    numEl.textContent = metric.text;
    const lblEl = document.createElement('div');
    lblEl.className = 'monitoring-metric-label';
    lblEl.textContent = metric.label;
    el.appendChild(numEl);
    el.appendChild(lblEl);
  }

  return { triggerQuery, onQueryResult, onQueryError, onTableQueryResult };
}

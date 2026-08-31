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
import { previewCanvasIdFor } from './edit-form';

/**
 * The three mutually-exclusive preview panes inside an edit form. Showing one
 * means hiding the other two, which is the only thing every preview path did by
 * hand three times over.
 * @type {Array<[ 'canvas' | 'table' | 'metric', string ]>}
 */
const PREVIEW_PANES = [
  ['canvas', '.monitoring-preview-canvas'],
  ['table', '.monitoring-preview-table'],
  ['metric', '.monitoring-preview-metric'],
];

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
  /**
   * The edit form that asked for this preview, or `null` if it is gone.
   *
   * A preview reply carries only the `__preview__<key>` id the form minted, so
   * the canvas that id names is what identifies the owning form; everything the
   * reply then touches — the chart-type select, the three panes, the status
   * line, the error box — is read out of THAT form and no other.
   *
   * This used to be `grid.querySelector('.monitoring-preview-canvas')` plus
   * `findEditCard()`: the FIRST open form, which is only the right one while at
   * most one is open. Two are reachable — `switchToEditMode` closes no others
   * and `addNewCard` inserts one at `grid.firstChild` — and then form B's rows
   * were drawn into form A's pane using A's chart type (so a `metric` A hid B's
   * canvas entirely and showed B's number in A's tile), and B's failures
   * appeared in A's error box. Exactly the position matching the save/delete
   * replies were moved off; this was the last of it.
   *
   * @param {string} previewConfigId
   * @returns {{ form: HTMLElement, canvas: HTMLElement | null } | null}
   */
  function previewTarget(previewConfigId) {
    const canvas = document.getElementById(previewCanvasIdFor(previewConfigId));
    const form = canvas && canvas.closest('.monitoring-edit-form');
    return form ? { form: /** @type {HTMLElement} */ (form), canvas } : null;
  }

  /**
   * @param {HTMLElement} form
   * @param {string} selector
   * @returns {HTMLElement | null}
   */
  function inForm(form, selector) {
    return /** @type {HTMLElement | null} */ (form.querySelector(selector));
  }

  /**
   * @param {HTMLElement} form
   * @param {'canvas' | 'table' | 'metric'} shown
   */
  function showPreviewPane(form, shown) {
    for (const [name, selector] of PREVIEW_PANES) {
      const el = inForm(form, selector);
      if (el) el.style.display = name === shown ? '' : 'none';
    }
  }

  /**
   * @param {HTMLElement} form
   * @param {string} text
   */
  function setPreviewStatus(form, text) {
    const status = inForm(form, '.monitoring-status');
    if (status) status.textContent = text;
  }

  /** @param {any} data */
  function handlePreviewResult(data) {
    const target = previewTarget(data.configId);
    if (!target) return; // The form that asked is gone; there is nowhere to render.
    const { form, canvas } = target;

    const typeSelect = /** @type {HTMLSelectElement | null} */ (
      form.querySelector('.monitoring-chart-type-select')
    );
    const previewChartType = typeSelect ? typeSelect.value : 'bar';

    if (previewChartType === 'metric') {
      showPreviewPane(form, 'metric');
      const metricEl = inForm(form, '.monitoring-preview-metric');
      if (metricEl) renderMetricInEl(metricEl, data, null);
    } else {
      showPreviewPane(form, 'canvas');
      chartRenderer.renderChart(data.configId, data, canvas, previewChartType, false, []);
    }
    setPreviewStatus(form, L.statusRows(data.totalRows));
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
      const target = previewTarget(data.configId);
      // Dropped rather than shown somewhere else: the form that ran this query
      // is gone, and putting its error in whichever form happens to be open —
      // which is what the old first-match lookup did — is worse than silence.
      if (!target) return;
      setPreviewStatus(target.form, '');
      const errBox = inForm(target.form, '.error-box');
      if (errBox) {
        errBox.textContent = data.message;
        errBox.style.display = '';
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
      const target = previewTarget(data.configId);
      if (!target) return;
      showPreviewPane(target.form, 'table');
      const tableEl = inForm(target.form, '.monitoring-preview-table');
      if (tableEl) tableRenderer.renderTableInEl(tableEl, data);
      setPreviewStatus(target.form, L.statusRows(data.totalRows));
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
      empty.textContent = metric.notNumeric
        ? L.statusNoNumericData(metric.notNumeric)
        : L.statusNoData;
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

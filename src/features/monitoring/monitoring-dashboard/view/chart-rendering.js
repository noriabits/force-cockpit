// @ts-check
// Chart.js rendering for the monitoring dashboard: dataset/scale/tooltip
// builders, create/destroy lifecycle, and on-the-fly type switching. Owns no
// state of its own — the `chartInstances` Map and labels are injected via ctx,
// keeping a single owner for chart lifecycle (see CLAUDE.md risks note).
import { formatValue } from './format-value';

/** Palette applied one colour per label across datasets */
export const CHART_COLORS = [
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

/** Chart types rendered with a Chart.js canvas */
export const CHART_TYPES_WITH_CANVAS = ['bar', 'line', 'pie', 'doughnut'];

/** All chart types including metric and table — used in the edit-form dropdown */
export const ALL_CHART_TYPES = [...CHART_TYPES_WITH_CANVAS, 'metric', 'table'];

/**
 * @typedef {Object} ChartRendererCtx
 * @property {Map<string, any>} chartInstances
 * @property {any} labels
 * @property {(configId: string, text: string) => void} setCardStatus
 */

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
 * @param {ChartRendererCtx} ctx
 */
export function createChartRenderer(ctx) {
  const { chartInstances, labels: L, setCardStatus } = ctx;
  const win = /** @type {any} */ (window);

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

  /**
   * Re-type and re-colour an existing view-mode chart in place.
   * @param {any} cfg
   * @param {string} newType
   */
  function switchChartType(cfg, newType) {
    const chart = chartInstances.get(cfg.id);
    if (!chart) return;
    const isMultiColor = newType === 'pie' || newType === 'doughnut';
    chart.config.type = newType;
    // Re-color datasets: always one color per label
    const chartLabels = /** @type {any[]} */ (chart.data.labels ?? []);
    const perLabelColors = chartLabels.map(
      (/** @type {any} */ _l, /** @type {number} */ idx) => CHART_COLORS[idx % CHART_COLORS.length],
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
  }

  return { renderChart, switchChartType };
}

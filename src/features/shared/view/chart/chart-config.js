// @ts-check
// Chart.js configuration builders shared by every surface that draws a chart:
// the monitoring dashboard's cards and the SOQL tab's 📊 Chart pane. Pure — each
// builder returns plain objects; creating/destroying the Chart instance stays
// with the caller, which is the one that knows its own lifecycle.
import { formatValue } from './format-value';

/** Palette applied one colour per label across datasets */
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

/** Chart types rendered with a Chart.js canvas */
export const CHART_TYPES_WITH_CANVAS = ['bar', 'line', 'pie', 'doughnut'];

/** @param {string} type */
function isMultiColorType(type) {
  return type === 'pie' || type === 'doughnut';
}

/**
 * One colour per label, shared by every dataset.
 * @param {any[]} labels
 */
function perLabelColors(labels) {
  return labels.map(
    (/** @type {any} */ _l, /** @type {number} */ idx) => CHART_COLORS[idx % CHART_COLORS.length],
  );
}

/**
 * @param {any[]} labels
 * @param {any[]} datasets
 * @returns {any[]}
 */
function buildChartDatasets(labels, datasets) {
  const colors = perLabelColors(labels);
  return datasets.map((/** @type {any} */ ds) => ({
    label: ds.label,
    data: ds.data,
    backgroundColor: colors,
    borderColor: colors,
    pointBackgroundColor: colors,
    pointBorderColor: colors,
    borderWidth: 1,
  }));
}

/**
 * Pie/doughnut have no axes; bar/line get x + y, the y ticks formatted with the
 * first value field's format.
 * @param {string} type
 * @param {boolean} stacked
 * @param {any[]} [valueFields]
 * @returns {any}
 */
function buildChartScales(type, stacked, valueFields) {
  if (isMultiColorType(type)) return {};
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
 * @param {any[]} [valueFields]
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
 * The full config object handed to `new Chart(canvas, config)`.
 * @param {{ labels: any[], datasets: any[], type?: string, stacked?: boolean, valueFields?: any[] }} opts
 * @returns {any}
 */
export function buildChartConfig({ labels, datasets, type, stacked, valueFields }) {
  const chartType = type || 'bar';
  return {
    type: chartType,
    data: { labels, datasets: buildChartDatasets(labels, datasets) },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: datasets.length > 1 || isMultiColorType(chartType),
          labels: { color: '#cccccc' },
        },
        tooltip: { callbacks: buildChartTooltip(valueFields) },
      },
      scales: buildChartScales(chartType, Boolean(stacked), valueFields),
    },
  };
}

/**
 * Re-type and re-colour an existing chart in place (then `update()` it).
 * @param {any} chart A live Chart.js instance
 * @param {string} type
 * @param {boolean} stacked
 * @param {any[]} [valueFields]
 */
export function retypeChart(chart, type, stacked, valueFields) {
  chart.config.type = type;
  const colors = perLabelColors(/** @type {any[]} */ (chart.data.labels ?? []));
  chart.data.datasets.forEach((/** @type {any} */ ds) => {
    ds.backgroundColor = colors;
    ds.borderColor = colors;
    ds.pointBackgroundColor = colors;
    ds.pointBorderColor = colors;
  });
  if (chart.options.plugins && chart.options.plugins.legend) {
    chart.options.plugins.legend.display = chart.data.datasets.length > 1 || isMultiColorType(type);
  }
  chart.options.scales = buildChartScales(type, stacked, valueFields);
  chart.update();
}

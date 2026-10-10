// @ts-check
// Chart.js rendering for the monitoring dashboard: create/destroy lifecycle and
// on-the-fly type switching. The config builders (colours, scales, tooltips)
// are the shared `shared/view/chart/chart-config.js`, also used by the SOQL
// tab's chart pane. Owns no state of its own — the `chartInstances` Map and
// labels are injected via ctx, keeping a single owner for chart lifecycle.
import { nonNumericDatasets } from '../../../shared/view/chart/numeric-data';
import {
  CHART_TYPES_WITH_CANVAS,
  buildChartConfig,
  retypeChart,
} from '../../../shared/view/chart/chart-config';

/** All chart types including metric and table — used in the edit-form dropdown */
export const ALL_CHART_TYPES = [...CHART_TYPES_WITH_CANVAS, 'metric', 'table'];

/**
 * @typedef {Object} ChartRendererCtx
 * @property {Map<string, any>} chartInstances
 * @property {any} labels
 * @property {(configId: string, text: string) => void} setCardStatus
 */

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

    // Rows came back but NOTHING in them is a number — a text column charted as
    // a measure. Bail only when every dataset fails: with a mix, the numeric
    // ones still plot and the chart is worth drawing. Without this the canvas
    // stays blank while the legend renders from `labels`, which reads as a
    // broken card rather than a misconfigured one.
    const unplottable = nonNumericDatasets(data.datasets);
    if (unplottable.length > 0 && unplottable.length === (data.datasets?.length ?? 0)) {
      setCardStatus(configId, L.statusNoNumericData(unplottable.join(', ')));
      return;
    }

    const chart = new win.Chart(
      canvas,
      buildChartConfig({
        labels: data.labels,
        datasets: data.datasets,
        type: chartType,
        stacked,
        valueFields,
      }),
    );
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
    retypeChart(chart, newType, cfg.stacked || false, cfg.valueFields);
  }

  return { renderChart, switchChartType };
}

// Pure guard for "the query returned rows, but nothing in them can be plotted".
//
// The host coerces every value with `Number(r[vf.field] ?? 0)`
// (MonitoringDashboardService.runQuery), so charting a TEXT column — a record
// Id, a picklist, a Name — yields NaN rather than an error. Chart.js then draws
// zero-size arcs while the legend still renders from `labels`, so the card
// looks broken rather than misconfigured. The existing `labels.length === 0`
// guard cannot catch it: the labels are perfectly valid, it is the measure that
// is not a number.
//
// DOM-free so it can be unit-tested; the status write stays in the view.
// Mirrors format-value.ts / metric-value.ts.

interface Dataset {
  label?: string;
  data: unknown[];
}

/**
 * Labels of the datasets holding no finite number — nothing for Chart.js to draw.
 *
 * `Number.isFinite` rather than `!isNaN`: it rejects Infinity (which Chart.js
 * cannot scale either) and does NOT coerce, so a value that arrived over
 * postMessage as a string is correctly reported as unplottable instead of
 * silently passing the way `!isNaN('5')` would.
 */
export function nonNumericDatasets(datasets: Dataset[] | null | undefined): string[] {
  return (datasets ?? [])
    .map((ds, i) => ({ label: ds?.label || `Series ${i + 1}`, data: ds?.data ?? [] }))
    .filter((ds) => !ds.data.some((v) => Number.isFinite(v)))
    .map((ds) => ds.label);
}

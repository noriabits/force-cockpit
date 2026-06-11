// Pure extraction of the metric-card value logic: given a query result and the
// config's value fields, decide whether there is data and produce the formatted
// number + label strings. DOM-free so it can be unit-tested; the DOM writing
// stays in the view (renderMetricInEl). Mirrors format-value.ts / table-sort.ts.
import { formatValue } from './format-value';

interface MetricDataset {
  label?: string;
  data: number[];
}

interface MetricData {
  datasets?: MetricDataset[];
}

interface MetricValueField {
  format?: 'currency' | 'percent';
}

export type MetricExtraction = { empty: true } | { empty: false; text: string; label: string };

/**
 * Extract the single metric value from a query result.
 * Returns `{ empty: true }` when there is no dataset or no data points.
 */
export function extractMetric(
  data: MetricData,
  valueFields: MetricValueField[] | null | undefined,
): MetricExtraction {
  const dataset = data.datasets?.[0];
  if (!data.datasets || data.datasets.length === 0 || !dataset || dataset.data.length === 0) {
    return { empty: true };
  }
  const value = dataset.data[0];
  const fmt = valueFields?.[0]?.format;
  return {
    empty: false,
    text: formatValue(value, fmt),
    label: dataset.label || '',
  };
}

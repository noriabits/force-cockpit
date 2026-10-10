// PURE core of the SOQL tab's 📊 Chart pane: which columns can be plotted,
// what to plot by default, the Chart.js-ready data, and the Monitoring config a
// 📌 Pin writes. DOM-free so it type-checks under the host tsconfig and is
// unit-tested on its own; the pane (chart-pane.tsx) only renders what this
// decides.
//
// Input is the results table's own view (`getView()`): flattened dotted column
// names (`Owner.Name`) and cells already stringified (`'5'`, `null`). Charting
// that view rather than the raw records is what makes the chart follow the
// table's filter and sort.
import { isSalesforceRecordId } from '../../../../../utils/salesforce';
import type { ChartType, MonitoringConfigPayload } from '../../../../../shared/protocol';
import { parseSelectClause } from '../fields/select-clause';

export type ChartPaneType = Extract<ChartType, 'bar' | 'line' | 'pie' | 'doughnut' | 'metric'>;

export const CHART_PANE_TYPES: ChartPaneType[] = ['bar', 'line', 'pie', 'doughnut', 'metric'];

export interface ChartSelection {
  labelField: string;
  valueFields: string[];
  chartType: ChartPaneType;
}

/** Display label per column name, for the columns that have a better one. */
export type ColumnLabels = Record<string, string>;

/**
 * A function call with nothing after its closing paren — i.e. no alias.
 * `COUNT(Id) n` has one, so it is named `n`, not `exprN`.
 */
const UNALIASED_CALL = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(.*\)$/s;

/**
 * Functions that keep the field's own name instead of taking an `exprN` slot.
 * `FORMAT(Amount)` still comes back as `Amount`.
 */
const NAME_KEEPING_FUNCTIONS = new Set(['format', 'tolabel', 'convertcurrency']);

/**
 * Readable labels for the `exprN` columns of an aggregate query. Salesforce
 * names every UNALIASED aggregate `expr0`, `expr1`, … in the order they appear
 * in the SELECT list, so `SELECT StageName, COUNT(Id), SUM(Amount)` returns
 * `expr0`/`expr1`. That is meaningless on a legend or a tooltip, so the label
 * is the expression itself (`COUNT(Id)`). The column NAME stays `exprN`: it is
 * the record key, and the key a pinned Monitoring card must read.
 */
export function expressionLabels(soql: string): ColumnLabels {
  const clause = parseSelectClause(soql);
  const labels: ColumnLabels = {};
  if (!clause) return labels;
  let n = 0;
  for (const { text } of clause.items) {
    const call = UNALIASED_CALL.exec(text);
    if (!call || NAME_KEEPING_FUNCTIONS.has(call[1].toLowerCase())) continue;
    labels[`expr${n++}`] = text.replace(/\s+/g, ' ');
  }
  return labels;
}

export interface ChartData {
  labels: string[];
  datasets: Array<{ label: string; data: number[] }>;
  /** Rows beyond the cap were left out of `labels`/`datasets`. */
  truncated: boolean;
}

type Cell = string | null;

/** A bar or pie with more than this many slices stops being readable. */
const MAX_CHART_POINTS = 100;

/** Pie reads well for a handful of slices only. */
const MAX_PIE_SLICES = 8;

/** More series than this and every bar is a sliver. */
const MAX_DEFAULT_SERIES = 3;

function isBlank(cell: Cell): boolean {
  return cell === null || cell.trim() === '';
}

function isNumericCell(cell: Cell): boolean {
  return !isBlank(cell) && Number.isFinite(Number(cell));
}

/**
 * Columns whose non-blank cells all parse as finite numbers, with at least one
 * such cell. A column that is all blank is not numeric: there is nothing in it
 * to plot, and offering it would draw an empty chart.
 */
export function numericColumns(cols: string[], rows: Cell[][]): string[] {
  return cols.filter((_, i) => {
    let seen = false;
    for (const row of rows) {
      const cell = row[i];
      if (isBlank(cell)) continue;
      if (!isNumericCell(cell)) return false;
      seen = true;
    }
    return seen;
  });
}

/** True when every non-blank cell of the column is a record Id. */
function isIdColumn(index: number, rows: Cell[][]): boolean {
  let seen = false;
  for (const row of rows) {
    const cell = row[index];
    if (isBlank(cell)) continue;
    if (!isSalesforceRecordId(cell)) return false;
    seen = true;
  }
  return seen;
}

/**
 * The label column: the first that is neither numeric nor all record Ids (an Id
 * is unique per row, so it labels nothing a reader can compare). Falls back to
 * the first non-numeric column, and to `''` when every column is a number
 * (`SELECT COUNT(Id) n FROM Case`) — a numeric column is a measure, never a
 * label, so it stays available as a series.
 */
function pickLabelField(cols: string[], rows: Cell[][], numeric: Set<string>): string {
  const texty = cols.filter((c) => !numeric.has(c));
  const readable = texty.find((c) => !isIdColumn(cols.indexOf(c), rows));
  return readable ?? texty[0] ?? '';
}

function pickChartType(rowCount: number, seriesCount: number, hasLabel: boolean): ChartPaneType {
  if (rowCount === 1 && seriesCount === 1 && !hasLabel) return 'metric';
  if (seriesCount === 1 && rowCount <= MAX_PIE_SLICES) return 'pie';
  return 'bar';
}

/**
 * The default chart for a result: a readable label column, up to three numeric
 * series, and a type that suits the shape. `null` when nothing is numeric — the
 * pane then says so instead of drawing an empty canvas.
 */
export function suggestChart(cols: string[], rows: Cell[][]): ChartSelection | null {
  const numeric = numericColumns(cols, rows);
  if (numeric.length === 0) return null;
  const labelField = pickLabelField(cols, rows, new Set(numeric));
  const valueFields = numeric.filter((c) => c !== labelField).slice(0, MAX_DEFAULT_SERIES);
  if (valueFields.length === 0) return null;
  return {
    labelField,
    valueFields,
    chartType: pickChartType(rows.length, valueFields.length, labelField !== ''),
  };
}

/**
 * Chart.js-ready data, the shape `MonitoringQueryResult` already has. A blank
 * value plots as 0, matching what a pinned card will show (the host's
 * `Number(value ?? 0)`). With no label column each point is numbered by row.
 */
export function toChartData(
  cols: string[],
  rows: Cell[][],
  selection: Pick<ChartSelection, 'labelField' | 'valueFields'>,
  columnLabels: ColumnLabels = {},
  cap = MAX_CHART_POINTS,
): ChartData {
  const shown = rows.slice(0, cap);
  const labelIndex = cols.indexOf(selection.labelField);
  return {
    labels: shown.map((row, n) => (labelIndex === -1 ? String(n + 1) : (row[labelIndex] ?? ''))),
    datasets: selection.valueFields.map((field) => {
      const i = cols.indexOf(field);
      return {
        label: columnLabels[field] ?? field,
        data: shown.map((row) => (isNumericCell(row[i]) ? Number(row[i]) : 0)),
      };
    }),
    truncated: rows.length > cap,
  };
}

export interface PinInput extends ChartSelection {
  columnLabels?: ColumnLabels;
  name: string;
  folder: string;
  soql: string;
  refreshInterval: number;
}

/**
 * Why a selection cannot be pinned, or `null` when it can. Monitoring's parser
 * skips a non-metric config with no `labelField`, so pinning one would write a
 * file that never shows up.
 */
export function pinBlocker(selection: ChartSelection | null): 'noSeries' | 'noLabel' | null {
  if (!selection || selection.valueFields.length === 0) return 'noSeries';
  if (selection.chartType !== 'metric' && !selection.labelField) return 'noLabel';
  return null;
}

/**
 * The Monitoring config a 📌 Pin saves. `id` is empty and `source` absent: the
 * host derives the id from folder + name, and an absent source is what tells
 * the repository there is no previous file to move. A metric has no label axis,
 * which is also how Monitoring's own parser accepts one without `labelField`.
 */
export function toPinConfig(input: PinInput): MonitoringConfigPayload {
  return {
    id: '',
    folder: input.folder.trim() || 'soql',
    name: input.name.trim(),
    description: 'Pinned from the SOQL tab.',
    soql: input.soql,
    labelField: input.chartType === 'metric' ? '' : input.labelField,
    valueFields: input.valueFields.map((field) => ({
      field,
      label: input.columnLabels?.[field] ?? field,
    })),
    chartType: input.chartType,
    refreshInterval: input.refreshInterval,
  };
}

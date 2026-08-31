// @vitest-environment jsdom
//
// Pins that a preview reply reaches the edit form that ASKED for it.
//
// Several edit forms can be open at once — `switchToEditMode` closes no others
// and `addNewCard` inserts one at `grid.firstChild` — and a preview reply
// carries no card identity beyond the `__preview__<key>` id the form minted.
// The routing used to be `grid.querySelector('.monitoring-preview-canvas')`
// plus `findEditCard()`: the FIRST open form, which is the right one only while
// at most one is open. Same position matching the save/delete replies were
// moved off; these tests are what stop it coming back.
//
// Every case here delivers the reply for the SECOND form. Delivering the first
// form's reply passes under the old first-match lookup too and proves nothing.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, cleanup } from '@testing-library/preact';

vi.mock('./chart-rendering', () => ({
  ALL_CHART_TYPES: ['bar', 'line', 'pie', 'doughnut', 'metric', 'table'],
}));
vi.mock('../../../shared/view/folder-combobox.js', () => ({
  buildFolderCombobox: () => {
    const element = document.createElement('div');
    element.appendChild(document.createElement('input'));
    return { element, cleanup() {}, refresh() {}, open() {}, close() {} };
  },
}));
vi.mock('../../../shared/view/host', () => ({ post: () => {} }));

const { createEditForm } = await import('./edit-form');
const { createQueryRunner } = await import('./query-runner');

const labels = {
  formatOptions: { '': 'None' },
  conditionOptions: { above: 'Above' },
  chartTypes: {
    bar: 'Bar',
    line: 'Line',
    pie: 'Pie',
    doughnut: 'Doughnut',
    metric: 'Metric',
    table: 'Table',
  },
  btnDelete: 'Delete',
  btnCancel: 'Cancel',
  btnSave: 'Save',
  btnSaving: 'Saving...',
  btnPreview: 'Preview',
  errorNameRequired: 'Name is required.',
  errorSoqlRequired: 'SOQL query is required.',
  errorLabelFieldRequired: 'Label field is required.',
  statusLoading: 'Loading...',
  statusNoData: 'No data',
  statusRows: (n: number) => `${n} rows`,
};

const baseCfg = {
  id: 'ops/chart',
  folder: 'ops',
  name: 'Chart',
  description: '',
  soql: 'SELECT Id FROM Account',
  labelField: 'Name',
  valueFields: [{ field: 'Cnt', label: 'Count' }],
  chartType: 'bar' as const,
  refreshInterval: 0,
  source: 'user' as const,
};

/** One chart-shaped result payload; the numbers are never asserted on. */
const result = (configId: string, totalRows = 3) => ({
  configId,
  totalRows,
  labels: ['a', 'b'],
  datasets: [{ label: 'Count', data: [1, 2] }],
});

let grid: HTMLElement;
let renderedCharts: Array<{ configId: string; canvas: HTMLElement | null; chartType: string }>;
let renderedTables: HTMLElement[];
let runner: ReturnType<typeof createQueryRunner>;

function mountForm(configId: string | null) {
  (window as unknown as { __setTooltip: () => void }).__setTooltip = () => {};
  const card = document.createElement('div');
  card.className = 'card monitoring-card';
  grid.appendChild(card);
  const form = createEditForm({
    labels,
    chartInstances: new Map(),
    getConfigs: () => [baseCfg],
    nextAvailablePosition: () => 0,
    buildViewCard: () => document.createElement('div'),
    triggerQuery: () => {},
  } as never).buildEditForm(
    { ...baseCfg, id: configId ?? '' } as never,
    card as never,
    configId as never,
  );
  card.appendChild(form);
  return form;
}

/**
 * The id this form's previews are sent under, read back off the one element it
 * deliberately gives an id to. Nothing else in the form carries one.
 */
function previewIdOf(form: HTMLElement): string {
  const canvas = form.querySelector('.monitoring-preview-canvas') as HTMLElement;
  return '__preview__' + canvas.id.replace('chart-preview-', '');
}

const paneDisplay = (form: HTMLElement, cls: string) =>
  (form.querySelector(cls) as HTMLElement).style.display;

const statusOf = (form: HTMLElement) => form.querySelector('.monitoring-status')!.textContent;
const errorOf = (form: HTMLElement) => form.querySelector('.error-box')!.textContent;

const setChartType = (form: HTMLElement, value: string) =>
  fireEvent.change(form.querySelector('.monitoring-chart-type-select')!, { target: { value } });

describe('preview result routing', () => {
  afterEach(cleanup);
  beforeEach(() => {
    // These forms are mounted by hand, so `cleanup` does not remove them.
    document.body.innerHTML = '';
    grid = document.createElement('div');
    document.body.appendChild(grid);
    renderedCharts = [];
    renderedTables = [];
    runner = createQueryRunner({
      labels,
      vscode: { postMessage: () => {} },
      grid,
      getConnected: () => true,
      getConfigs: () => [baseCfg],
      chartRenderer: {
        renderChart: (
          configId: string,
          _data: unknown,
          canvas: HTMLElement | null,
          chartType: string,
        ) => renderedCharts.push({ configId, canvas, chartType }),
      },
      tableRenderer: {
        renderTable: () => {},
        renderTableInEl: (el: HTMLElement) => renderedTables.push(el),
      },
      setCardStatus: () => {},
      setCardError: () => {},
      findCardTypeSelect: () => null,
    } as never);
  });

  it('renders a chart preview into the form that asked, not the first one open', () => {
    const first = mountForm('ops/a');
    const second = mountForm('ops/b');

    runner.onQueryResult(result(previewIdOf(second)));

    expect(renderedCharts).toHaveLength(1);
    expect(renderedCharts[0].canvas).toBe(second.querySelector('.monitoring-preview-canvas'));
    expect(statusOf(second)).toBe('3 rows');
    expect(statusOf(first)).toBe('');
  });

  it('reads the chart type off the asking form, not the first one open', () => {
    // The sharpest version of the bug: with the first form set to `metric`, the
    // second form's rows were drawn into the FIRST form's metric tile and the
    // second form's canvas was hidden — from a reply that named the second.
    const first = mountForm('ops/a');
    const second = mountForm('ops/b');
    setChartType(first, 'metric');

    runner.onQueryResult(result(previewIdOf(second)));

    expect(renderedCharts[0].chartType).toBe('bar');
    expect(paneDisplay(second, '.monitoring-preview-canvas')).toBe('');
    expect(paneDisplay(second, '.monitoring-preview-metric')).toBe('none');
    // The first form is untouched: its panes are still as its mount effect left
    // them (canvas visible, the other two hidden).
    expect(paneDisplay(first, '.monitoring-preview-metric')).toBe('none');
  });

  it('renders a table preview into the asking form', () => {
    const first = mountForm('ops/a');
    const second = mountForm('ops/b');
    setChartType(second, 'table');

    runner.onTableQueryResult(result(previewIdOf(second)));

    expect(renderedTables).toEqual([second.querySelector('.monitoring-preview-table')]);
    expect(paneDisplay(second, '.monitoring-preview-table')).toBe('');
    expect(paneDisplay(second, '.monitoring-preview-canvas')).toBe('none');
    expect(paneDisplay(first, '.monitoring-preview-table')).toBe('none');
  });

  it('shows a preview error in the asking form only', () => {
    const first = mountForm('ops/a');
    const second = mountForm('ops/b');

    runner.onQueryError({ configId: previewIdOf(second), message: 'MALFORMED_QUERY' });

    expect(errorOf(second)).toBe('MALFORMED_QUERY');
    expect(errorOf(first)).toBe('');
  });

  it('drops a reply whose form is gone rather than showing it in another', () => {
    const first = mountForm('ops/a');
    const second = mountForm('ops/b');
    const staleId = previewIdOf(second);
    second.closest('.card')!.remove();

    runner.onQueryResult(result(staleId));
    runner.onQueryError({ configId: staleId, message: 'boom' });

    expect(renderedCharts).toHaveLength(0);
    expect(statusOf(first)).toBe('');
    expect(errorOf(first)).toBe('');
  });

  it('gives two brand-new cards distinct preview ids', () => {
    // Both have `configId === null` (`+ Add Chart` twice), so a per-config id
    // would collide and `document.getElementById` would hand both replies to
    // whichever rendered first.
    const a = mountForm(null);
    const b = mountForm(null);
    expect(previewIdOf(a)).not.toBe(previewIdOf(b));

    runner.onQueryResult(result(previewIdOf(b)));
    expect(renderedCharts[0].canvas).toBe(b.querySelector('.monitoring-preview-canvas'));
  });
});

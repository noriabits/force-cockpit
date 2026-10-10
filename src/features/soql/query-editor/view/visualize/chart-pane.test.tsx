// @vitest-environment jsdom
//
// Drives createChartPane through its real seams: the toggle button, the DOM it
// renders, `refresh()` (what the results table's onViewChanged calls), the
// posts it makes, and host replies delivered through `__onMessage`. Chart.js is
// a stub that records the config of every chart created and destroyed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent } from '@testing-library/preact';

type View = { cols: string[]; rows: (string | null)[][] };
type Handler = (msg: unknown) => void;

const handlers = new Map<string, Handler[]>();
const posted: any[] = [];
const charts: Array<{ config: any; destroyed: boolean }> = [];

class FakeChart {
  entry: { config: any; destroyed: boolean };
  constructor(_canvas: HTMLCanvasElement, config: any) {
    this.entry = { config, destroyed: false };
    charts.push(this.entry);
  }
  destroy() {
    this.entry.destroyed = true;
  }
}

const w = window as any;
w.__vscode = { postMessage: (m: unknown) => posted.push(m) };
w.__onMessage = (type: string, h: Handler) =>
  handlers.set(type, [...(handlers.get(type) ?? []), h]);
w.__setTooltip = (el: Element, text: string) => el.setAttribute('data-tooltip', text);
w.Chart = FakeChart;

const { createChartPane } = await import('./chart-pane');

/** `Array.prototype.at` is outside this tsconfig's lib. */
const last = <T,>(items: T[]): T => items[items.length - 1];

const AGGREGATE: View = {
  cols: ['StageName', 'n', 'amt'],
  rows: Array.from({ length: 10 }, (_, i) => [`Stage ${i}`, String(i + 1), String(i * 100)]),
};
const SOQL = 'SELECT StageName, COUNT(Id) n, SUM(Amount) amt FROM Opportunity GROUP BY StageName';

function deliver(type: string, data: unknown) {
  act(() => (handlers.get(type) ?? []).forEach((h) => h({ type, data })));
}

function setup(opts: { view?: View; tooling?: boolean; connected?: boolean } = {}) {
  document.body.innerHTML = `
    <button id="toggle"></button>
    <div class="table-wrapper"></div>
    <div id="pane" style="display:none"></div>`;
  const state = {
    view: opts.view ?? AGGREGATE,
    connected: opts.connected ?? true,
    run: { soql: SOQL, useToolingApi: !!opts.tooling, tabName: 'Opportunity' },
  };
  const toggle = document.getElementById('toggle') as HTMLButtonElement;
  const pane = document.getElementById('pane') as HTMLElement;
  const wrapper = document.querySelector('.table-wrapper') as HTMLElement;
  const api = createChartPane({
    mountEl: pane,
    toggleBtn: toggle,
    tableWrapperEl: wrapper,
    getView: () => state.view,
    getRunContext: () => state.run,
    isConnected: () => state.connected,
  });
  const showChart = () => act(() => toggle.click());
  const lastChart = () => last(charts.filter((c) => !c.destroyed));
  const pinBtn = () => pane.querySelector('.query-chart-pin-btn') as HTMLButtonElement;
  const form = () => pane.querySelector('.query-chart-pin-form') as HTMLFormElement | null;
  return { state, toggle, pane, wrapper, api, showChart, lastChart, pinBtn, form };
}

function inputLabelled(root: HTMLElement, label: string) {
  const span = [...root.querySelectorAll('.query-chart-control > span')].find(
    (s) => s.textContent === label,
  );
  return span?.parentElement?.querySelector('input, select') as HTMLInputElement;
}

describe('chart pane', () => {
  beforeEach(() => {
    posted.length = 0;
    charts.length = 0;
    handlers.clear();
  });
  afterEach(cleanup);

  it('swaps the table for the chart and back, with the toggle naming the other view', () => {
    const s = setup();
    expect(s.pane.style.display).toBe('none');
    s.showChart();
    expect(s.pane.style.display).toBe('');
    expect(s.wrapper.style.display).toBe('none');
    expect(s.toggle.textContent).toContain('Table');
    act(() => s.toggle.click());
    expect(s.wrapper.style.display).toBe('');
    expect(s.pane.style.display).toBe('none');
  });

  it('draws the inferred chart: text label, every numeric series', () => {
    const s = setup();
    s.showChart();
    const config = s.lastChart()!.config;
    expect(config.type).toBe('bar');
    expect(config.data.labels).toHaveLength(10);
    expect(config.data.datasets.map((d: any) => d.label)).toEqual(['n', 'amt']);
  });

  it('redraws with fewer points when the table filter narrows the view', () => {
    const s = setup();
    s.showChart();
    s.state.view = { cols: AGGREGATE.cols, rows: AGGREGATE.rows.slice(0, 2) };
    act(() => s.api.refresh());
    expect(s.lastChart()!.config.data.labels).toEqual(['Stage 0', 'Stage 1']);
    expect(charts.filter((c) => !c.destroyed)).toHaveLength(1);
  });

  it('keeps a hand-picked series across a filter, and re-infers for a new column set', () => {
    const s = setup();
    s.showChart();
    const amt = [...s.pane.querySelectorAll('.query-chart-value')]
      .find((l) => l.textContent?.includes('amt'))!
      .querySelector('input')!;
    act(() => void fireEvent.click(amt));
    expect(s.lastChart()!.config.data.datasets.map((d: any) => d.label)).toEqual(['n']);

    s.state.view = { cols: AGGREGATE.cols, rows: AGGREGATE.rows.slice(0, 5) };
    act(() => s.api.refresh());
    expect(s.lastChart()!.config.data.datasets.map((d: any) => d.label)).toEqual(['n']);

    s.state.view = {
      cols: ['Status', 'c'],
      rows: [
        ['Open', '1'],
        ['Closed', '2'],
      ],
    };
    act(() => s.api.refresh());
    expect(s.lastChart()!.config.type).toBe('pie');
  });

  it('labels an unaliased aggregate by its expression, not exprN', () => {
    const s = setup({
      view: { cols: ['Type', 'expr0'], rows: Array.from({ length: 10 }, (_, i) => [`T${i}`, '1']) },
    });
    s.state.run.soql = 'SELECT Type, COUNT(Id) FROM Case GROUP BY Type';
    s.showChart();
    expect(s.lastChart()!.config.data.datasets[0].label).toBe('COUNT(Id)');
    expect(s.pane.querySelector('.query-chart-value')?.textContent).toBe('COUNT(Id)');
    act(() => s.pinBtn().click());
    act(() => void fireEvent.submit(s.form()!));
    expect(last(posted).config.valueFields).toEqual([{ field: 'expr0', label: 'COUNT(Id)' }]);
  });

  it('changes the chart type from the select', () => {
    const s = setup();
    s.showChart();
    act(() => void fireEvent.change(inputLabelled(s.pane, 'Type'), { target: { value: 'line' } }));
    expect(s.lastChart()!.config.type).toBe('line');
  });

  it('renders a single unlabelled value as a metric tile, with no canvas', () => {
    const s = setup({ view: { cols: ['n'], rows: [['1234']] } });
    s.showChart();
    expect(s.pane.querySelector('.query-chart-metric-number')?.textContent).toBe(
      (1234).toLocaleString(),
    );
    expect(charts).toHaveLength(0);
  });

  it('says so when no column holds numbers', () => {
    const s = setup({ view: { cols: ['Name'], rows: [['Acme']] } });
    s.showChart();
    expect(s.pane.textContent).toContain('no column in this result holds numbers');
  });

  it('pins the query that produced the rows, create-only and origin-tagged', () => {
    const s = setup();
    s.showChart();
    act(() => s.pinBtn().click());
    expect(inputLabelled(s.form()!, 'Name').value).toBe('Opportunity');
    act(
      () =>
        void fireEvent.input(inputLabelled(s.form()!, 'Name'), { target: { value: 'Pipeline' } }),
    );
    act(
      () =>
        void fireEvent.change(inputLabelled(s.form()!, 'Refresh'), { target: { value: '300' } }),
    );
    act(() => void fireEvent.submit(s.form()!));

    const msg = last(posted);
    expect(msg).toMatchObject({
      type: 'saveMonitoringConfig',
      origin: 'soql-pin',
      createOnly: true,
      isPrivate: false,
      config: {
        name: 'Pipeline',
        folder: 'soql',
        soql: SOQL,
        labelField: 'StageName',
        valueFields: [
          { field: 'n', label: 'n' },
          { field: 'amt', label: 'amt' },
        ],
        chartType: 'bar',
        refreshInterval: 300,
      },
    });
    expect(msg.requestId).toMatch(/^soql-pin-/);
  });

  it('refuses a blank name without posting', () => {
    const s = setup();
    s.showChart();
    act(() => s.pinBtn().click());
    act(() => void fireEvent.input(inputLabelled(s.form()!, 'Name'), { target: { value: '  ' } }));
    act(() => void fireEvent.submit(s.form()!));
    expect(posted).toHaveLength(0);
    expect(s.pane.textContent).toContain('Name is required');
  });

  it('disables Pin for a Tooling API query, saying why', () => {
    const s = setup({ tooling: true });
    s.showChart();
    expect(s.pinBtn().getAttribute('aria-disabled')).toBe('true');
    expect(s.pinBtn().getAttribute('data-tooltip')).toContain('Tooling API');
    act(() => s.pinBtn().click());
    expect(s.form()).toBeNull();
  });

  it('disables Pin for a non-metric chart with no label column', () => {
    const s = setup();
    s.showChart();
    act(() => void fireEvent.change(inputLabelled(s.pane, 'Label'), { target: { value: '' } }));
    expect(s.pinBtn().getAttribute('aria-disabled')).toBe('true');
    expect(s.pinBtn().getAttribute('data-tooltip')).toContain('label column');
  });

  it('reads only the reply to its own request, and confirms a pin', () => {
    const s = setup();
    s.showChart();
    act(() => s.pinBtn().click());
    act(() => void fireEvent.submit(s.form()!));
    const { requestId } = last(posted);

    deliver('saveMonitoringConfigResult', { requestId: 'mon-7', config: { name: 'Other' } });
    expect(s.form()).not.toBeNull();

    deliver('saveMonitoringConfigResult', { requestId, config: { name: 'Opportunity' } });
    expect(s.form()).toBeNull();
    expect(s.pane.textContent).toContain('Pinned "Opportunity"');

    const activate = vi.fn();
    w.__activateTab = activate;
    act(() => (s.pane.querySelector('.query-chart-pin-saved a') as HTMLElement).click());
    expect(activate).toHaveBeenCalledWith('monitoring');
  });

  it('shows a failed pin inline and keeps the form open', () => {
    const s = setup();
    s.showChart();
    act(() => s.pinBtn().click());
    act(() => void fireEvent.submit(s.form()!));
    const { requestId } = last(posted);
    deliver('saveMonitoringConfigError', {
      requestId,
      message: 'A chart named "Opportunity" already exists in "soql".',
    });
    expect(s.form()).not.toBeNull();
    expect(s.pane.querySelector('.query-chart-pin-error')?.textContent).toContain('already exists');
  });

  it('reset drops the chart and the pin form', () => {
    const s = setup();
    s.showChart();
    act(() => s.pinBtn().click());
    act(() => s.api.reset());
    expect(s.form()).toBeNull();
    expect(charts.every((c) => c.destroyed)).toBe(true);
  });
});

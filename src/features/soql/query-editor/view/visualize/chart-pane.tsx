// The SOQL tab's 📊 Chart pane: the active tab's result drawn as a chart, and
// 📌 Pin to Monitoring, which saves that chart as a Monitoring dashboard card.
//
// ── WHAT GOES WHERE ──────────────────────────────────────────────────────────
// `chart-inference.ts` (pure) decides what can be plotted, the default chart,
// the Chart.js data and the config a pin writes. This file owns the DOM, the
// Chart.js instance and the pin round trip. The Chart.js config itself is the
// shared `shared/view/chart/chart-config.js`, so a chart here and the card it
// becomes in Monitoring are drawn by the same builder.
//
// ── THE MOUNT SEAM ───────────────────────────────────────────────────────────
// `mountEl` is the mount CONTAINER (Preact owns its children). `toggleBtn` and
// `tableWrapperEl` are pre-existing DOM from view.html that `index.js` also
// holds, so they are written from an `effect()` rather than rendered. The
// canvas is an uncontrolled leaf: Chart.js owns it, so it is built imperatively
// into a ref'd container and the vdom never diffs it.
//
// ── IT FOLLOWS THE TABLE ─────────────────────────────────────────────────────
// The data is `getView()` — the table's filtered + sorted rows — and `index.js`
// calls `refresh()` from the table's `onViewChanged`, so typing in the filter
// narrows the chart. The column choice is re-inferred only when the column SET
// changes (a new result), never on a filter keystroke, so a hand-picked series
// survives filtering.
//
// ── STATE LIVES IN THE FACTORY CLOSURE ───────────────────────────────────────
// `refresh`/`reset` and the host replies are called from outside any render, so
// state is a plain `signal()` bag here, never `useSignal` or module scope.
//
// ── THE PIN ──────────────────────────────────────────────────────────────────
// Reuses `saveMonitoringConfig`; no new message name. `origin: 'soql-pin'` tells
// the monitoring webview (which receives every save reply too) to insert the
// card in place and leave the error to us; `createOnly` stops a name collision
// from silently overwriting an existing chart. The SOQL saved is the query that
// PRODUCED these rows (echoed onto the result), not whatever is in the editor
// now, and only replies carrying the requestId minted here are read.

import { render, type Ref } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { batch, computed, effect, signal } from '@preact/signals';
import { post, on } from '../../../../shared/view/host';
import { buildChartConfig } from '../../../../shared/view/chart/chart-config';
import { formatValue } from '../../../../shared/view/chart/format-value';
import type { SaveMonitoringConfigMessage } from '../../../../../shared/protocol';
import {
  CHART_PANE_TYPES,
  expressionLabels,
  numericColumns,
  pinBlocker,
  suggestChart,
  toChartData,
  toPinConfig,
  type ChartData,
  type ChartPaneType,
  type ChartSelection,
  type ColumnLabels,
} from './chart-inference';

const win = window as unknown as {
  Chart?: new (canvas: HTMLCanvasElement, config: unknown) => { destroy(): void };
  __setTooltip: (el: Element, text: string) => void;
  __activateTab?: (tabId: string) => void;
};

const L = {
  showChart: '📊 Chart',
  showTable: '▦ Table',
  label: 'Label',
  values: 'Values',
  type: 'Type',
  noLabel: '(row number)',
  types: { bar: 'Bar', line: 'Line', pie: 'Pie', doughnut: 'Doughnut', metric: 'Metric' },
  nothingNumeric: 'Nothing to chart — no column in this result holds numbers.',
  noRows: 'No rows to chart.',
  truncated: (shown: number, total: number) => `Charting the first ${shown} of ${total} rows.`,
  pin: '📌 Pin to Monitoring',
  pinTooltip: 'Save this chart as a Monitoring dashboard card',
  blockedTooling:
    'Monitoring runs queries on the Standard API — a Tooling API query cannot be pinned.',
  blockedOffline: 'Not connected to any org.',
  blockedNoSeries: 'Pick at least one value column to pin.',
  blockedNoLabel: 'Pick a label column — only a Metric can be pinned without one.',
  name: 'Name',
  category: 'Category',
  private: 'Private',
  refresh: 'Refresh',
  refreshOptions: [
    [0, 'Manual'],
    [60, 'Every minute'],
    [300, 'Every 5 minutes'],
    [900, 'Every 15 minutes'],
  ] as const,
  save: 'Pin',
  saving: 'Pinning…',
  cancel: 'Cancel',
  nameRequired: 'Name is required.',
  pinned: (name: string) => `📌 Pinned "${name}".`,
  openMonitoring: 'Open in Monitoring',
};

const DEFAULT_FOLDER = 'soql';

type Cell = string | null;

interface View {
  cols: string[];
  rows: Cell[][];
}

interface RunContext {
  /** The query that produced the rows on screen. */
  soql: string;
  useToolingApi: boolean;
  /** The active tab's title, the pin name's default. */
  tabName: string;
}

interface PinStatus {
  kind: 'saving' | 'saved' | 'error';
  text: string;
}

export interface ChartPaneCtx {
  mountEl: HTMLElement;
  toggleBtn: HTMLButtonElement;
  tableWrapperEl: HTMLElement;
  getView: () => View;
  getRunContext: () => RunContext | null;
  isConnected: () => boolean;
}

/** Tooltips ride `data-tooltip` (media/modules/tooltip.js), not `title`. */
function useTooltip(text: string) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (ref.current) win.__setTooltip(ref.current, text);
  }, [text]);
  return ref;
}

/** Chart.js owns the canvas: built imperatively, destroyed on every redraw. */
function ChartCanvas({ data, type }: { data: ChartData; type: ChartPaneType }) {
  const hostRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || !win.Chart) return;
    const canvas = document.createElement('canvas');
    host.appendChild(canvas);
    const chart = new win.Chart(
      canvas,
      buildChartConfig({ labels: data.labels, datasets: data.datasets, type }),
    );
    return () => {
      chart.destroy();
      canvas.remove();
    };
  }, [data, type]);
  return <div class="query-chart-canvas" ref={hostRef} />;
}

function MetricTile({ data }: { data: ChartData }) {
  const series = data.datasets[0];
  return (
    <div class="query-chart-metric">
      <div class="query-chart-metric-number">{formatValue(series?.data[0])}</div>
      <div class="query-chart-metric-label">{series?.label ?? ''}</div>
    </div>
  );
}

export function createChartPane(ctx: ChartPaneCtx) {
  const mode = signal<'table' | 'chart'>('table');
  const view = signal<View>({ cols: [], rows: [] });
  const selection = signal<ChartSelection | null>(null);
  /** `expr0` → `COUNT(Id)`, from the query that produced the rows. */
  const columnLabels = signal<ColumnLabels>({});
  let colsKey = '';

  const pinOpen = signal(false);
  const pinName = signal('');
  const pinFolder = signal(DEFAULT_FOLDER);
  const pinPrivate = signal(false);
  const pinRefresh = signal(0);
  const pinStatus = signal<PinStatus | null>(null);
  let pendingRequestId: string | null = null;
  let requestSeq = 0;

  const numeric = computed(() => numericColumns(view.value.cols, view.value.rows));
  const chartData = computed(() =>
    selection.value
      ? toChartData(view.value.cols, view.value.rows, selection.value, columnLabels.value)
      : null,
  );

  /** Re-read the table's view; re-infer the columns only for a new column set. */
  function refresh() {
    if (mode.value !== 'chart') return;
    const next = ctx.getView();
    const key = next.cols.join('\u0000');
    batch(() => {
      view.value = next;
      if (key !== colsKey) {
        colsKey = key;
        selection.value = suggestChart(next.cols, next.rows);
        columnLabels.value = expressionLabels(ctx.getRunContext()?.soql ?? '');
        pinOpen.value = false;
        pinStatus.value = null;
      }
    });
  }

  /** The result went away (cleared, failed, another org): drop chart and pin state. */
  function reset() {
    colsKey = '';
    pendingRequestId = null;
    batch(() => {
      view.value = { cols: [], rows: [] };
      selection.value = null;
      columnLabels.value = {};
      pinOpen.value = false;
      pinStatus.value = null;
    });
  }

  function update(patch: Partial<ChartSelection>) {
    const current = selection.value ?? { labelField: '', valueFields: [], chartType: 'bar' };
    selection.value = { ...current, ...patch };
  }

  function toggleValue(field: string, checked: boolean) {
    const current = selection.value?.valueFields ?? [];
    const next = checked ? [...current, field] : current.filter((f) => f !== field);
    // Keep the column order of the result, not the order they were ticked in.
    update({ valueFields: view.value.cols.filter((c) => next.includes(c)) });
  }

  /** Why Pin is unavailable right now, as the tooltip shown on it; null when it is. */
  function pinBlockedReason(): string | null {
    const run = ctx.getRunContext();
    if (!ctx.isConnected()) return L.blockedOffline;
    if (run?.useToolingApi) return L.blockedTooling;
    const blocker = pinBlocker(selection.value);
    if (blocker === 'noSeries') return L.blockedNoSeries;
    if (blocker === 'noLabel') return L.blockedNoLabel;
    return run ? null : L.blockedOffline;
  }

  function openPin() {
    if (pinBlockedReason()) return;
    batch(() => {
      pinName.value = ctx.getRunContext()?.tabName ?? '';
      pinStatus.value = null;
      pinOpen.value = true;
    });
  }

  function submitPin() {
    const run = ctx.getRunContext();
    const sel = selection.value;
    if (!run || !sel || pinBlockedReason()) return;
    if (!pinName.value.trim()) {
      pinStatus.value = { kind: 'error', text: L.nameRequired };
      return;
    }
    pendingRequestId = `soql-pin-${++requestSeq}`;
    pinStatus.value = { kind: 'saving', text: '' };
    post<SaveMonitoringConfigMessage>({
      type: 'saveMonitoringConfig',
      requestId: pendingRequestId,
      origin: 'soql-pin',
      createOnly: true,
      isPrivate: pinPrivate.value,
      config: toPinConfig({
        ...sel,
        columnLabels: columnLabels.value,
        name: pinName.value,
        folder: pinFolder.value,
        soql: run.soql,
        refreshInterval: pinRefresh.value,
      }),
    });
  }

  on<{ requestId?: string; config?: { name?: string } }>('saveMonitoringConfigResult', (msg) => {
    if (!pendingRequestId || msg.data?.requestId !== pendingRequestId) return;
    pendingRequestId = null;
    batch(() => {
      pinOpen.value = false;
      pinStatus.value = { kind: 'saved', text: L.pinned(msg.data?.config?.name ?? pinName.value) };
    });
  });
  on<{ requestId?: string; message?: string }>('saveMonitoringConfigError', (msg) => {
    if (!pendingRequestId || msg.data?.requestId !== pendingRequestId) return;
    pendingRequestId = null;
    pinStatus.value = { kind: 'error', text: msg.data?.message ?? '' };
  });

  ctx.toggleBtn.addEventListener('click', () => {
    mode.value = mode.value === 'chart' ? 'table' : 'chart';
    refresh();
  });

  effect(() => {
    const showChart = mode.value === 'chart';
    ctx.toggleBtn.textContent = showChart ? L.showTable : L.showChart;
    ctx.tableWrapperEl.style.display = showChart ? 'none' : '';
    ctx.mountEl.style.display = showChart ? '' : 'none';
  });

  function Controls({ sel }: { sel: ChartSelection }) {
    const labelOptions = view.value.cols.filter((c) => !numeric.value.includes(c));
    return (
      <div class="query-chart-controls">
        <label class="query-chart-control">
          <span>{L.type}</span>
          <select
            class="text-input"
            value={sel.chartType}
            onChange={(e) =>
              update({ chartType: (e.currentTarget as HTMLSelectElement).value as ChartPaneType })
            }
          >
            {CHART_PANE_TYPES.map((t) => (
              <option value={t}>{L.types[t]}</option>
            ))}
          </select>
        </label>
        {sel.chartType !== 'metric' && (
          <label class="query-chart-control">
            <span>{L.label}</span>
            <select
              class="text-input"
              value={sel.labelField}
              onChange={(e) => update({ labelField: (e.currentTarget as HTMLSelectElement).value })}
            >
              <option value="">{L.noLabel}</option>
              {labelOptions.map((c) => (
                <option value={c}>{c}</option>
              ))}
            </select>
          </label>
        )}
        <div class="query-chart-control query-chart-values">
          <span>{L.values}</span>
          {numeric.value.map((c) => (
            <label class="query-chart-value">
              <input
                type="checkbox"
                checked={sel.valueFields.includes(c)}
                onChange={(e) => toggleValue(c, (e.currentTarget as HTMLInputElement).checked)}
              />
              {columnLabels.value[c] ?? c}
            </label>
          ))}
        </div>
      </div>
    );
  }

  function PinButton() {
    const blocked = pinBlockedReason();
    const ref = useTooltip(blocked ?? L.pinTooltip);
    // aria-disabled, never `disabled`: tooltips ride a delegated mouseover, and
    // browsers send none to a disabled control — the reason would be invisible.
    return (
      <button
        type="button"
        class="btn btn-ghost query-chart-pin-btn"
        aria-disabled={blocked ? 'true' : 'false'}
        ref={ref as Ref<HTMLButtonElement>}
        onClick={openPin}
      >
        {L.pin}
      </button>
    );
  }

  function PinForm() {
    const saving = pinStatus.value?.kind === 'saving';
    return (
      <form
        class="query-chart-pin-form"
        onSubmit={(e) => {
          e.preventDefault();
          submitPin();
        }}
      >
        <label class="query-chart-control">
          <span>{L.name}</span>
          <input
            class="text-input"
            value={pinName.value}
            onInput={(e) => (pinName.value = (e.currentTarget as HTMLInputElement).value)}
          />
        </label>
        <label class="query-chart-control">
          <span>{L.category}</span>
          <input
            class="text-input"
            value={pinFolder.value}
            onInput={(e) => (pinFolder.value = (e.currentTarget as HTMLInputElement).value)}
          />
        </label>
        <label class="query-chart-control">
          <span>{L.refresh}</span>
          <select
            class="text-input"
            value={String(pinRefresh.value)}
            onChange={(e) =>
              (pinRefresh.value = Number((e.currentTarget as HTMLSelectElement).value))
            }
          >
            {L.refreshOptions.map(([seconds, text]) => (
              <option value={String(seconds)}>{text}</option>
            ))}
          </select>
        </label>
        <label class="query-chart-value">
          <input
            type="checkbox"
            checked={pinPrivate.value}
            onChange={(e) => (pinPrivate.value = (e.currentTarget as HTMLInputElement).checked)}
          />
          {L.private}
        </label>
        <button type="submit" class="btn btn-primary" disabled={saving}>
          {saving ? L.saving : L.save}
        </button>
        <button type="button" class="btn btn-ghost" onClick={() => (pinOpen.value = false)}>
          {L.cancel}
        </button>
      </form>
    );
  }

  function PinStatusLine() {
    const status = pinStatus.value;
    if (!status || status.kind === 'saving') return null;
    if (status.kind === 'error') return <div class="query-chart-pin-error">{status.text}</div>;
    return (
      <div class="query-chart-pin-saved">
        {status.text}{' '}
        <a href="#" onClick={(e) => (e.preventDefault(), win.__activateTab?.('monitoring'))}>
          {L.openMonitoring}
        </a>
      </div>
    );
  }

  function Body() {
    const sel = selection.value;
    const data = chartData.value;
    if (view.value.rows.length === 0) return <div class="query-chart-empty">{L.noRows}</div>;
    if (!sel) return <div class="query-chart-empty">{L.nothingNumeric}</div>;
    return (
      <>
        <div class="query-chart-header">
          <Controls sel={sel} />
          <span class="query-toolbar-spacer" />
          <PinButton />
        </div>
        {pinOpen.value && <PinForm />}
        <PinStatusLine />
        {data && data.truncated && (
          <div class="query-chart-note">
            {L.truncated(data.labels.length, view.value.rows.length)}
          </div>
        )}
        {data && sel.valueFields.length > 0 && sel.chartType === 'metric' && (
          <MetricTile data={data} />
        )}
        {data && sel.valueFields.length > 0 && sel.chartType !== 'metric' && (
          <ChartCanvas data={data} type={sel.chartType} />
        )}
      </>
    );
  }

  render(<Body />, ctx.mountEl);

  return { refresh, reset };
}

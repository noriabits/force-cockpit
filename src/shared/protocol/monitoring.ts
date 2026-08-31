// Fully-typed payloads for the monitoring dashboard's routes — the first
// feature to be typed end to end (the pilot for the Preact migration).
//
// Every other feature still rides the loose `WebviewMessage` / `HostMessage`
// envelope from `./messages`, which already type-checks the *names*. Payloads
// get tightened per feature, as each one is migrated. Do not bulk-convert.
//
// Same hard constraint as `messages.ts`: no imports from `vscode` or the DOM.
// The monitoring domain types are re-declared here rather than imported from
// `features/monitoring/dashboard/types.ts` because that module is compiled by
// the host tsconfig only, and this one must compile under both.

export type ChartType = 'bar' | 'line' | 'pie' | 'doughnut' | 'metric' | 'table';
export type ValueFormat = 'currency' | 'percent';
export type ThresholdCondition = 'above' | 'below';
export type ConfigSource = 'builtin' | 'user' | 'private';

export interface ValueFieldPayload {
  field: string;
  label: string;
  format?: ValueFormat;
  threshold?: number;
  thresholdCondition?: ThresholdCondition;
}

export interface MonitoringConfigPayload {
  id: string;
  folder: string;
  name: string;
  description: string;
  soql: string;
  labelField: string;
  valueFields: ValueFieldPayload[];
  chartType: ChartType;
  refreshInterval: number;
  stacked?: boolean;
  notifyOnIncrease?: boolean;
  source?: ConfigSource;
  position?: number;
}

// ── webview -> host ──────────────────────────────────────────────────────────

/**
 * Correlates a submit with its reply.
 *
 * Several edit forms can be open at once and each Save is independent, so two
 * can be in flight together. The replies carry no card identity of their own,
 * and matching them by "the first card still waiting" delivered one form's
 * failure to another — or, once a success disarmed the wrong form, to no form
 * at all. The webview mints this; `MessageRouter._dispatchFeatureRoute` echoes
 * the whole request onto both the success and the error reply, so it comes back
 * for free with no host-side handling.
 */
export interface CorrelatedMessage {
  requestId: string;
}

export interface SaveMonitoringConfigMessage extends CorrelatedMessage {
  type: 'saveMonitoringConfig';
  /** `config.source` carries the PREVIOUS location, so the host knows which
   *  base path to delete the old file from when a rename/move changes the
   *  derived id. There is no separate `previousSource` field. */
  config: MonitoringConfigPayload;
  isPrivate: boolean;
}

export interface DeleteMonitoringConfigMessage extends CorrelatedMessage {
  type: 'deleteMonitoringConfig';
  configId: string;
  configName: string;
  source: ConfigSource;
  isPrivate: boolean;
}

export interface RunMonitoringQueryMessage {
  type: 'runMonitoringQuery' | 'runMonitoringTableQuery';
  /** A `__preview__`-prefixed id marks an edit-form preview. That PREFIX is the
   *  only signal — the host tests it to decide whether to fire notifications, so
   *  there is deliberately no separate `preview` flag to keep in step with it. */
  configId: string;
  /** Only read for a non-preview run; falls back to `configId`. */
  configName: string;
  soql: string;
  labelField: string;
  valueFields: ValueFieldPayload[];
  /** Optional because an edit-form preview omits it: the host reads this only
   *  after the `__preview__` guard above, so a preview has nothing to say. */
  notifyOnIncrease?: boolean;
}

// ── host -> webview ──────────────────────────────────────────────────────────

// NOTE: the host->webview result payloads (loadMonitoringConfigsResult,
// runMonitoringQueryResult, …) are deliberately NOT typed here yet. The webview
// side that consumes them is still plain `.js` (`query-runner.js`,
// `config-loader.js`), so a type here would have no consumer to enforce it and
// would drift out of step with the routes unnoticed. Add them when those
// modules migrate.

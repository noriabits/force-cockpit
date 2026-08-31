// Shared types for the Debug Logs feature. Kept vscode-free so every
// collaborator (api/, parsing/, ai/) can be unit-tested in plain Node.

/** The eight debug log categories, as named on the Tooling `DebugLevel` object. */
export type LogCategory =
  | 'ApexCode'
  | 'ApexProfiling'
  | 'Callout'
  | 'Database'
  | 'System'
  | 'Validation'
  | 'Visualforce'
  | 'Workflow';

/** Cumulative severity levels — a higher level only adds events. */
export type LogLevel = 'NONE' | 'ERROR' | 'WARN' | 'INFO' | 'DEBUG' | 'FINE' | 'FINER' | 'FINEST';

export type CategoryLevels = Record<LogCategory, LogLevel>;

/** A named set of category levels the user can pick without thinking about the matrix. */
export interface DebugLevelPreset {
  id: string;
  label: string;
  /** One line shown as the dropdown subtitle. */
  whenToUse: string;
  /** The longer explanation shown under the picker once selected. */
  description: string;
  /** The single "pick this if you don't know" preset. Exactly one preset sets it. */
  recommended?: boolean;
  /** Warn that this preset fills the 20 MB log budget quickly. */
  truncationWarning?: boolean;
  levels: CategoryLevels;
}

/** `USER_DEBUG` traces a user; `CLASS_TRACING` overrides levels inside one class/trigger. */
export type TraceLogType = 'USER_DEBUG' | 'CLASS_TRACING' | 'DEVELOPER_LOG';

/** Something a trace flag can be attached to. */
export interface TraceEntity {
  id: string;
  name: string;
  /** Username for users, or the class/trigger type for Apex entities. */
  subtitle: string;
  kind: 'user' | 'apexClass' | 'apexTrigger';
  /** Marks the Automated Process / integration users the Setup UI cannot reach. */
  system?: boolean;
}

/** An active (or scheduled) trace flag as shown in the panel. */
export interface TraceFlagInfo {
  id: string;
  tracedEntityId: string;
  entityName: string;
  entityKind: TraceEntity['kind'];
  logType: TraceLogType;
  debugLevelId: string;
  debugLevelName: string;
  startDate: string;
  expirationDate: string;
}

/** One row of the log list — the projection of ApexLog we query. */
export interface ApexLogRow {
  id: string;
  logUserId: string;
  logUserName: string;
  operation: string;
  application: string;
  /** 'Success', or the unhandled exception text. */
  status: string;
  request: string;
  durationMilliseconds: number;
  logLength: number;
  startTime: string;
}

/** Thresholds driving the "hide empty logs" filter. Overridable from config.yaml. */
export interface NoiseOptions {
  maxEmptyBytes: number;
  maxEmptyDurationMs: number;
  /** Case-insensitive substrings matched against ApexLog.Operation. */
  operationPatterns: string[];
}

/** One parsed debug-log line. */
export interface LogEvent {
  /** 1-based line number in the raw log. */
  lineNo: number;
  /** 'HH:mm:ss.SSS', or '' for continuation lines. */
  time: string;
  /** Nanoseconds since the start of the request, or null on continuation lines. */
  nanos: number | null;
  /** Event identifier, e.g. 'USER_DEBUG'. '' for continuation lines. */
  event: string;
  /** Pipe-delimited fields after the event identifier. */
  fields: string[];
  raw: string;
}

/** The category/level header at the top of every debug log. */
export interface LogHeader {
  apiVersion: string;
  levels: Partial<Record<string, LogLevel>>;
  raw: string;
}

/** A single governor limit reading pulled from LIMIT_USAGE_FOR_NS. */
export interface LimitUsage {
  name: string;
  used: number;
  max: number;
  /** 0–100, or null when max is 0/unknown. */
  percent: number | null;
}

export interface CodeUnitTiming {
  name: string;
  totalMs: number;
  selfMs: number;
  lineNo: number;
}

export interface LogSummary {
  durationMs: number | null;
  truncated: boolean;
  limits: LimitUsage[];
  counts: {
    soql: number;
    sosl: number;
    dml: number;
    callouts: number;
    userDebug: number;
    exceptions: number;
    rows: number;
  };
  slowestUnits: CodeUnitTiming[];
  /** Exception/FATAL_ERROR messages in order of appearance. */
  exceptions: { lineNo: number; message: string; stack: string[] }[];
}

/** `SOQL_EXECUTE_EXPLAIN`'s leading operation type — how the query was resolved. */
export type QueryPlanOperation = 'TableScan' | 'Index' | 'Other' | 'Unknown';

export type QueryPlanRating = 'critical' | 'warning' | 'good' | 'unknown';

/** One SOQL statement paired with its (optional) query plan and row count. */
export interface QueryPlanEntry {
  /** Line of the SOQL_EXECUTE_BEGIN event. */
  lineNo: number;
  /** The `[42]` source-line marker, or null for `[EXTERNAL]`/unmarked queries. */
  sourceLine: number | null;
  text: string;
  /** Rows returned, from SOQL_EXECUTE_END — null if the log was truncated before it. */
  rows: number | null;
  operation: QueryPlanOperation;
  /** The sObject the plan resolved against, or null when no explain was captured. */
  object: string | null;
  /** Indexed field(s) used by the plan, e.g. `['QuoteId']` — empty for TableScan/no index. */
  fieldsUsed: string[];
  /** Estimated rows the plan expects to return. */
  cardinality: number | null;
  /** Total rows on the sObject at plan time. */
  sobjectCardinality: number | null;
  /** Salesforce's own selectivity estimate — below 1 is considered selective. */
  relativeCost: number | null;
  rating: QueryPlanRating;
}

export type IssueSeverity = 'critical' | 'warning' | 'info';

export interface LogIssue {
  rule: string;
  severity: IssueSeverity;
  title: string;
  detail: string;
  /** Line to jump to in the viewer, when the rule has a single anchor. */
  lineNo: number | null;
  /** Short supporting quotes/values, already trimmed for display. */
  evidence: string[];
  suggestion: string;
}

/** A node of the execution tree built from CODE_UNIT/METHOD entry-exit pairs. */
export interface ExecNode {
  name: string;
  kind: 'codeUnit' | 'method';
  lineNo: number;
  startNanos: number | null;
  totalMs: number | null;
  selfMs: number | null;
  children: ExecNode[];
}

/** Everything the host computes for one opened log. */
export interface ParsedLog {
  header: LogHeader | null;
  events: LogEvent[];
  summary: LogSummary;
  issues: LogIssue[];
  tree: ExecNode[];
  queryPlans: QueryPlanEntry[];
}

// Payloads for the ▶️ Apex tab (ad-hoc Execute Anonymous). Typed from day one,
// as a new feature should be; see `monitoring.ts` for the per-feature rule.
//
// Same hard constraint as `messages.ts`: no imports. The parsed-log fields are
// `unknown` on purpose — their real shapes (`LogEvent`, `LogSummary`, …) live in
// the host-only `debug-logs/explorer/types.ts`, and the one consumer that reads
// them field by field is the Debug Logs viewer, a `// @ts-check` JS module that
// takes the payload as `any` anyway. Re-declaring nine types here to feed an
// untyped reader would be a second copy with nothing checking it.

/** What an Apex tab holds, and what a history row records. */
export interface ApexSnippet {
  code: string;
}

/** An explicitly saved/named snippet. */
export interface SavedApexSnippet extends ApexSnippet {
  name: string;
}

/** One editor tab, as persisted. Run outcomes are in-memory only. */
export interface ApexTab extends ApexSnippet {
  name: string;
  autoName?: boolean;
  nameObject?: string | null;
}

/** `apexStateLoaded`. */
export interface ApexState {
  tabs: ApexTab[];
  activeTab: number;
  history: ApexSnippet[];
  savedSnippets: SavedApexSnippet[];
  /** Debug-level preset the log is captured with (a `debugLevelPresets.ts` id). */
  presetId: string;
}

/** `executeAnonymousApex` (webview → host). */
export interface ExecuteAnonymousApexMessage {
  type: 'executeAnonymousApex';
  opId: string;
  code: string;
  presetId: string;
}

/** The debug log, parsed by the Debug Logs tab's own pipeline. */
export interface AnonymousApexLog {
  /** Empty when the log was too large to ship in full (`partial`). */
  body: string;
  partial: boolean;
  totalLines: number;
  header: unknown;
  events: unknown[];
  summary: unknown;
  issues: unknown[];
  tree: unknown[];
  queryPlans: unknown[];
}

/**
 * `anonymousApexExecuted`. A compile error or an uncaught exception is a normal
 * OUTCOME, not a route error — the log is exactly what the user needs then.
 * `anonymousApexError` is reserved for the call itself failing.
 */
export interface AnonymousApexOutcome {
  compiled: boolean;
  success: boolean;
  compileProblem: string | null;
  /** 1-based; null when Salesforce reported no position (it sends -1). */
  line: number | null;
  column: number | null;
  exceptionMessage: string | null;
  exceptionStackTrace: string | null;
  /** Null when the call produced no log (a compile error usually does not). */
  log: AnonymousApexLog | null;
}

// User-facing strings for the Debug Logs tab.
window.DebugLogsLabels = {
  // Trace flags
  entityHintMe: 'Traces the org user you are connected as.',
  entityHintSystem:
    'Async work — platform-event triggers, resumed flows, batch retries — logs under the ' +
    'Automated Process user, separately from whoever triggered it. Setup cannot trace these ' +
    'users; Force Cockpit sets the trace flag through the Tooling API.',
  entityHintUser: 'Search any user in the org by name or username.',
  entityHintApex:
    'Class tracing raises the log levels inside one class or trigger without generating its ' +
    'own log. Pair it with a quiet user trace to get detail without truncating.',
  searchPlaceholderUser: 'Search users by name or username…',
  searchPlaceholderApex: 'Search Apex classes and triggers…',
  noEntities: 'No matches.',
  selectEntityFirst: 'Pick something to trace first.',
  startTracing: 'Start tracing',
  tracingStarted: 'Tracing started.',
  tracingReplaced: 'Existing trace flag updated (only one per entity can be active).',
  noActiveFlags: 'No active trace flags.',
  stop: 'Stop',
  extend: 'Extend',
  expiresIn: 'expires in',
  expired: 'expired',
  recommendedSuffix: '⭐ Recommended',
  truncationWarning: '⚠ This level fills the 20 MB log budget quickly and will truncate.',
  sensitiveOrgNote: 'Sensitive org — "Production-safe" is preselected to keep log volume low.',
  customLevels: 'Custom…',
  presetLabel: 'Debug level',

  // Log list
  noLogs: 'No logs yet. Start a trace flag above, then run something in the org.',
  notConnected: 'Connect to an org to read its debug logs.',
  columns: ['Time', 'User', 'Operation', 'Status', 'Duration', 'Size', 'Request'],
  hiddenAsEmpty: (n) => `${n} hidden as empty`,
  show: 'Show',
  checkingContents: 'Checking log contents…',
  deleteSelected: (n) => (n > 0 ? `Delete (${n})` : 'Delete'),

  // Viewer
  summarySoql: 'SOQL',
  summaryDml: 'DML',
  summaryRows: 'Query rows',
  summaryCallouts: 'Callouts',
  truncatedChip: '⚠ truncated',
  noIssues: 'No issues detected by the built-in rules.',
  loadMore: 'Load more lines',
  linesShown: (shown, total) => `${shown} of ${total} lines`,
  partialLog: 'This log is too large to show in full — only its start and end are loaded.',

  // AI
  analyzing: 'Analyzing…',
  analyzeFailed: 'Analysis failed',
  applyLevels: 'Apply these levels',
  appliedLevels: 'Levels applied to the form above.',
  modelAuto: 'Auto',
  noModels: 'No language model available. Enable GitHub Copilot to use AI analysis.',
};

// The single source of truth for every message crossing the host <-> webview
// boundary.
//
// Why this exists: the two sides are separate bundles that can only talk in
// `postMessage` strings, so a typo used to be a *silent no-op* — the message
// left one side and nothing on the other side ever matched it. There was no
// compile step that could see both ends. This module is imported by the host
// TypeScript (`tsconfig.json`) AND by the webview bundles
// (`tsconfig.webview.json`), which is what makes a bad type name a build error
// instead of a bug someone finds in production.
//
// HARD CONSTRAINT: this file must import nothing — no `vscode`, no DOM, no Node
// built-ins. Both tsconfigs compile it, and they have disjoint `lib`/`types`
// (the host has no DOM; the webview has no @types/node). Types erase at build
// time and the const arrays inline, so it costs nothing at runtime.
//
// Adding a message: add the name to the matching union below FIRST, then use it.
// The unions are exhaustive — if a name is not here, it does not exist.
//
// Auditing these unions: the two states that indicate a REAL bug are
//   (a) a HostToWebviewType with no host producer  — a reply nothing can send
//       (this is how the dead `traceFlagsLoaded` route survived a refactor: the
//       webview still had a `case` for it, so a naive "is it referenced?" scan
//       called it live), and
//   (b) a WebviewToHostType with no host handler   — a message that goes nowhere,
//   (c) a webview `__onMessage(name)` whose name is in the OPPOSITE union — a
//       handler that can never fire, because nothing on the host posts an
//       inbound message under a webview->host name. `media/modules/
//       action-tracker.js` had two (`operationStarted`/`operationEnded`) with a
//       comment claiming the host echoed them back; it does not, and they were
//       removed. This one is only findable now that both directions are named
//       here — grepping for the string finds the OUTBOUND post and looks fine.
// All three are currently empty. A HostToWebviewType with a producer but no webview
// consumer is NOT a bug: `RouteDescriptor` requires both a `successType` and an
// `errorType`, so every route declares an error name whether or not the webview
// handles it, and several `*Done` acks are deliberately inert.

// ── webview -> host ──────────────────────────────────────────────────────────
// Requests. Most map 1:1 to a `RouteDescriptor` key registered by a feature
// (see `FeatureModule.routes`); the rest are the built-in cases handled inline
// by `MessageRouter.handle`.
export type WebviewToHostType =
  | 'addQueryHistory'
  | 'addRestCallHistory'
  | 'analyzeApexLog'
  | 'askAiQuestion'
  | 'browseForScriptFile'
  | 'cancelOperation'
  | 'classifyApexLogs'
  | 'cloneUser'
  | 'cloneUserSearch'
  | 'confirmAction'
  | 'deleteApexLogs'
  | 'deleteAskAiConversation'
  | 'deleteExecutionLogs'
  | 'deleteMonitoringConfig'
  | 'deleteYamlScript'
  | 'describeGlobal'
  | 'describeSObject'
  | 'editScriptCode'
  | 'executeYamlScript'
  | 'exportQueryResult'
  | 'extendTraceFlag'
  | 'generateSoqlQuery'
  | 'listChatModels'
  | 'listSkills'
  | 'loadApexLogs'
  | 'loadAskAiConversation'
  | 'loadAskAiHistory'
  | 'loadAskAiState'
  | 'loadDebugLogsSetup'
  | 'loadExecutionLogs'
  | 'loadFavorites'
  | 'loadMonitoringConfigs'
  | 'loadQueryState'
  | 'loadRestCallState'
  | 'loadYamlScripts'
  | 'notifyApexLogFailure'
  | 'openApexLog'
  | 'openApexLogRaw'
  | 'openExecutionLog'
  | 'openExternalUrl'
  | 'openInBrowser'
  | 'openRecord'
  | 'openScriptFile'
  | 'openScriptResult'
  | 'openScriptResultMarkdown'
  | 'openScriptYamlFile'
  | 'operationEnded'
  | 'operationStarted'
  | 'pluginInvoke'
  | 'query'
  | 'reactivateOmniscript'
  | 'reactivateOmniscriptFetch'
  | 'ready'
  | 'refreshOrg'
  | 'resetAskAiChat'
  | 'resetSoqlAiChat'
  | 'restCall'
  | 'restoreHiddenBuiltins'
  | 'runMonitoringQuery'
  | 'runMonitoringTableQuery'
  | 'saveApexLogAnalysis'
  | 'saveAskAiState'
  | 'saveDebugLogsState'
  | 'saveMonitoringConfig'
  | 'saveMonitoringPositions'
  | 'saveQueryTabs'
  | 'saveRestCallSavedRequests'
  | 'saveRestCallTabs'
  | 'saveSavedQueries'
  | 'saveYamlScript'
  | 'searchTraceEntities'
  | 'startTraceFlag'
  | 'stopTraceFlag'
  | 'toggleFavorite'
  | 'updateYamlScript';

// ── host -> webview ──────────────────────────────────────────────────────────
// Replies and pushes. Every route contributes a `successType` and an
// `errorType`; the rest are unsolicited pushes (org lifecycle, streaming log
// chunks, background refresh results, file-watcher notifications).
export type HostToWebviewType =
  | 'apexLogAnalysisSaveError'
  | 'apexLogAnalysisSaved'
  | 'apexLogAnalyzeError'
  | 'apexLogAnalyzed'
  | 'apexLogOpenError'
  | 'apexLogOpened'
  | 'apexLogsClassified'
  | 'apexLogsClassifyError'
  | 'apexLogsDeleteError'
  | 'apexLogsDeleted'
  | 'apexLogsError'
  | 'apexLogsLoaded'
  | 'askAiAnswer'
  | 'askAiChatReset'
  | 'askAiChatResetError'
  | 'askAiConversationDeleteError'
  | 'askAiConversationDeleted'
  | 'askAiConversationLoaded'
  | 'askAiConversationLoadedError'
  | 'askAiError'
  | 'askAiHistoryError'
  | 'askAiHistoryLoaded'
  | 'askAiStateError'
  | 'askAiStateLoaded'
  | 'askAiStateSaved'
  | 'browseForScriptFileError'
  | 'browseForScriptFileResult'
  | 'cancelAllOperations'
  | 'cloneUserError'
  | 'cloneUserResult'
  | 'cloneUserSearchError'
  | 'cloneUserSearchResult'
  | 'confirmActionResult'
  | 'debugLogsSetupError'
  | 'debugLogsSetupLoaded'
  | 'debugLogsStateError'
  | 'debugLogsStateSaved'
  | 'deleteExecutionLogsError'
  | 'deleteExecutionLogsResult'
  | 'deleteMonitoringConfigError'
  | 'deleteMonitoringConfigResult'
  | 'deleteYamlScriptError'
  | 'deleteYamlScriptResult'
  | 'describeError'
  | 'describeGlobalResult'
  | 'describeSObjectResult'
  | 'editScriptCodeDone'
  | 'editScriptCodeError'
  | 'executeYamlScriptError'
  | 'executeYamlScriptResult'
  | 'executionLogsChanged'
  | 'exportQueryResultDone'
  | 'exportQueryResultError'
  | 'listChatModelsError'
  | 'listChatModelsResult'
  | 'listSkillsError'
  | 'listSkillsResult'
  | 'loadExecutionLogsError'
  | 'loadExecutionLogsResult'
  | 'loadFavoritesError'
  | 'loadFavoritesResult'
  | 'loadMonitoringConfigsError'
  | 'loadMonitoringConfigsResult'
  | 'loadYamlScriptsError'
  | 'loadYamlScriptsResult'
  | 'monitoringBackgroundRefreshResult'
  | 'notifyApexLogFailureDone'
  | 'notifyApexLogFailureError'
  | 'openApexLogRawDone'
  | 'openApexLogRawError'
  | 'openExecutionLogError'
  | 'openExecutionLogResult'
  | 'openInBrowserDone'
  | 'openScriptFileError'
  | 'openScriptFileResult'
  | 'openScriptResultDone'
  | 'openScriptResultError'
  | 'openScriptResultMarkdownDone'
  | 'openScriptResultMarkdownError'
  | 'openScriptYamlFileDone'
  | 'openScriptYamlFileError'
  | 'orgConnected'
  | 'orgConnecting'
  | 'orgDisconnected'
  | 'panelVisibilityChanged'
  | 'pluginError'
  | 'pluginResult'
  | 'queryError'
  | 'queryHistoryError'
  | 'queryHistoryUpdated'
  | 'queryResult'
  | 'queryStateError'
  | 'queryStateLoaded'
  | 'queryTabsError'
  | 'queryTabsSaved'
  | 'reactivateOmniscriptError'
  | 'reactivateOmniscriptFetchError'
  | 'reactivateOmniscriptFetchResult'
  | 'reactivateOmniscriptResult'
  | 'refreshOrgDone'
  | 'releaseInfo'
  | 'reloadYamlScripts'
  | 'restCallError'
  | 'restCallHistoryError'
  | 'restCallHistoryUpdated'
  | 'restCallResult'
  | 'restCallSavedRequestsError'
  | 'restCallSavedRequestsUpdated'
  | 'restCallStateError'
  | 'restCallStateLoaded'
  | 'restoreHiddenBuiltinsError'
  | 'restoreHiddenBuiltinsResult'
  | 'runMonitoringQueryError'
  | 'runMonitoringQueryResult'
  | 'runMonitoringTableQueryError'
  | 'runMonitoringTableQueryResult'
  | 'saveMonitoringConfigError'
  | 'saveMonitoringConfigResult'
  | 'saveMonitoringPositionsError'
  | 'saveMonitoringPositionsResult'
  | 'saveYamlScriptError'
  | 'saveYamlScriptResult'
  | 'savedQueriesError'
  | 'savedQueriesUpdated'
  | 'scriptCodeUpdated'
  | 'scriptLogChunk'
  | 'soqlAiAnswer'
  | 'soqlAiChatReset'
  | 'soqlAiChatResetError'
  | 'soqlAiError'
  | 'storageLimits'
  | 'toggleFavoriteError'
  | 'toggleFavoriteResult'
  | 'traceEntitiesError'
  | 'traceEntitiesFound'
  | 'traceFlagError'
  | 'traceFlagExtended'
  | 'traceFlagStarted'
  | 'traceFlagStopped'
  | 'updateYamlScriptError'
  | 'updateYamlScriptResult';

// ── Envelopes ────────────────────────────────────────────────────────────────

/**
 * Anything the webview posts. `opId` is present on cancellable work: the host
 * registers an `AbortController` under it (`OperationRegistry`) and echoes it
 * back on both the success and error reply, which is how a reply is matched to
 * the tab/panel that started it.
 */
export interface WebviewMessage {
  type: WebviewToHostType;
  opId?: string;
  [key: string]: unknown;
}

/**
 * Anything the host posts. `MessageRouter._route` spreads the request's context
 * FIRST and the route's result over it, so `data` carries the echoed `opId`
 * alongside the payload while a key the route actually returns wins the
 * collision (`saveMonitoringConfig` posts `{ config }` and returns the
 * persisted `{ config }` — the reply must be the saved one, not the draft).
 */
export interface HostMessage<TData = unknown> {
  type: HostToWebviewType;
  data?: TData;
}

/** Shape of every `errorType` payload. */
export interface ErrorPayload {
  message: string;
  opId?: string;
  [key: string]: unknown;
}

/**
 * The two tab strips persist through the shared `createTabStrip`, which posts
 * `{ type: ctx.persistType }` — a *variable*, not a literal. Narrowing it here
 * keeps that one dynamic post inside the union instead of escaping it.
 */
export type TabPersistType = Extract<WebviewToHostType, 'saveQueryTabs' | 'saveRestCallTabs'>;

// NOTE: no runtime constants are exported here on purpose. The webview message
// dispatcher lives in `media/modules/ipc.js`, which is a plain non-bundled IIFE
// loaded by a <script> tag — it cannot `import` from this module, so it matches
// the raw strings and always will. Exporting a `STREAM_CHUNK`-style const would
// be a name with no possible consumer.

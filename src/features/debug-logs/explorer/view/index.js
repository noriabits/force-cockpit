// @ts-check
// Debug Logs orchestrator: owns the feature state, wires the four panels
// (trace flags, log list, log viewer, AI analysis) and routes host messages to
// them. Bundled by esbuild into dist/features/debug-logs/explorer/view.js.
import { createAiPanel } from './ai-panel';
import { createLogList } from './log-list';
import { createLogViewer } from './log-viewer';
import { createTraceFlagPanel } from './trace-flag-panel';

(function () {
  const win = /** @type {any} */ (window);
  const vscode = win.__vscode;
  const labels = win.DebugLogsLabels;
  const escapeHtml = /** @type {(s: string) => string} */ (win.__escapeHtml);

  let connected = false;
  let visible = true;
  let setupLoaded = false;
  /** @type {any[]} */ let logs = [];
  /** @type {any} */ let orgData = null;

  /** Persist a slice of panel state; the host merges it into workspaceState. */
  function saveState(/** @type {any} */ patch) {
    vscode.postMessage({ type: 'saveDebugLogsState', state: patch });
  }

  const tracePanel = createTraceFlagPanel({
    labels,
    vscode,
    escapeHtml,
    getOrgData: () => orgData,
    onStateChange: saveState,
  });

  const logList = createLogList({
    labels,
    vscode,
    escapeHtml,
    getConnected: () => connected,
    getVisible: () => visible,
    onOpenLog: (logId) => vscode.postMessage({ type: 'openApexLog', logId }),
    onStateChange: saveState,
  });

  const logViewer = createLogViewer({ labels, vscode, escapeHtml });

  const aiPanel = createAiPanel({
    labels,
    vscode,
    escapeHtml,
    getLogId: () => logViewer.getLogId(),
    onApplyLevels: (suggestion) => tracePanel.applySuggestion(suggestion),
    onStateChange: saveState,
  });

  // ── Viewer-level buttons ────────────────────────────────────────────────

  document.getElementById('dbg-open-raw')?.addEventListener('click', () => {
    const logId = logViewer.getLogId();
    if (logId) vscode.postMessage({ type: 'openApexLogRaw', logId });
  });
  document.getElementById('dbg-copy-log')?.addEventListener('click', () => {
    navigator.clipboard.writeText(logViewer.getRawText()).catch(() => {});
  });
  document.getElementById('dbg-close-viewer')?.addEventListener('click', () => {
    logViewer.hide();
    aiPanel.hide();
  });

  // ── Loading ─────────────────────────────────────────────────────────────

  function loadEverything() {
    if (!connected) return;
    vscode.postMessage({ type: 'loadDebugLogsSetup' });
    vscode.postMessage({ type: 'loadApexLogs' });
    // The model list is owned by the yaml-scripts feature; its route is global.
    vscode.postMessage({ type: 'listChatModels' });
  }

  // ── Message handlers ────────────────────────────────────────────────────

  /** Shared by the three trace-flag replies, which differ only in their name. */
  function applyTraceFlags(/** @type {any} */ data) {
    tracePanel.setTraceFlags(data.traceFlags ?? []);
  }

  /** @type {Record<string, (data: any) => void>} */
  const messageHandlers = {
    panelVisibilityChanged: (data) => {
      visible = !!data.visible;
    },

    debugLogsSetupLoaded: (data) => {
      setupLoaded = true;
      tracePanel.applySetup(data);
      logList.applyState(data.state ?? {});
      aiPanel.applyState(data.state ?? {});
    },
    debugLogsSetupError: (data) => tracePanel.showError(data.message),

    apexLogsLoaded: (data) => {
      logs = data.logs ?? [];
      logList.setLogs(logs);
      // The setup call can fail on a slow connect — retry it with the list.
      if (!setupLoaded && connected) vscode.postMessage({ type: 'loadDebugLogsSetup' });
    },
    apexLogsError: (data) => logList.showError(data.message),
    apexLogsClassified: (data) => logList.setClassification(data.results ?? []),
    apexLogsClassifyError: () => logList.setClassification([]),
    apexLogsDeleted: (data) => {
      if (!data.confirmed) return;
      logList.clearSelection();
      logViewer.hide();
      aiPanel.hide();
      vscode.postMessage({ type: 'loadApexLogs' });
    },
    apexLogsDeleteError: (data) => logList.showError(data.message),

    apexLogOpened: (data) => {
      const row = logs.find((log) => log.id === data.logId) ?? null;
      // An analysis belongs to the log it was run on — drop it when a
      // different log is opened (and cancel a run still streaming).
      aiPanel.resetFor(data.logId);
      logViewer.show(data, row);
      logList.setOpenLog(data.logId);
    },
    apexLogOpenError: (data) => logViewer.showError(data.message),

    traceFlagStarted: applyTraceFlags,
    traceFlagExtended: applyTraceFlags,
    traceFlagStopped: applyTraceFlags,
    traceFlagError: (data) => tracePanel.showError(data.message),
    traceEntitiesFound: (data) => tracePanel.showEntities(data.entities ?? []),
    traceEntitiesError: (data) => tracePanel.showError(data.message),

    listChatModelsResult: (data) => aiPanel.setModels(data.models ?? []),
    listChatModelsError: () => aiPanel.setModels([]),

    scriptLogChunk: (data) => {
      // Shared streaming channel — only take the chunks for our own run.
      if (data.opId && data.opId === aiPanel.getOpId()) aiPanel.appendChunk(data.chunk);
    },
    // Both echo back the logId they were requested for, so a result that
    // arrives after the user moved on is dropped instead of being shown
    // under the wrong log.
    apexLogAnalyzed: (data) => {
      if (data.logId === aiPanel.getAnalyzedLogId()) aiPanel.finish(data);
    },
    apexLogAnalyzeError: (data) => {
      if (data.logId === aiPanel.getAnalyzedLogId()) aiPanel.showError(data.message);
    },
  };

  win.__registerFeature('debug-logs', {
    onOrgConnected(/** @type {any} */ data) {
      connected = true;
      orgData = data;
      setupLoaded = false;
      loadEverything();
    },
    onOrgDisconnected() {
      connected = false;
      orgData = null;
      setupLoaded = false;
      logs = [];
      tracePanel.reset();
      logList.reset();
      logList.stopTail();
      logViewer.hide();
      aiPanel.hide();
    },
    onMessage(/** @type {{ type: string, data: any }} */ message) {
      const handler = messageHandlers[message.type];
      if (handler) handler(message.data ?? {});
    },
  });

  // The org may already be connected when this script loads (the panel sends
  // orgConnected on ready), so nothing to do here — loadEverything runs then.
})();

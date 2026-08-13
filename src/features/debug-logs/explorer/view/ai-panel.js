// @ts-check
// The AI analysis panel: model picker, tool toggles, streaming output, and the
// "Apply these levels" action built from the ```debug-level block the model
// ends its answer with.
import { wireCopyToClipboardButton } from '../../../shared/view/output-actions';
import {
  isScrolledToBottom,
  scrollToBottom,
  scrollAndHighlight,
  stickToBottom,
} from '../../../shared/view/scroll-highlight';
import { parseLevelSuggestion } from './apply-levels';

/**
 * @param {{
 *   labels: any,
 *   vscode: { postMessage: (msg: any) => void },
 *   escapeHtml: (s: string) => string,
 *   getLogId: () => string,
 *   onApplyLevels: (suggestion: any) => void,
 *   onStateChange: (patch: any) => void,
 * }} ctx
 */
export function createAiPanel(ctx) {
  const { labels, vscode, escapeHtml } = ctx;
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

  const panel = $('dbg-ai');
  const analyzeBtn = /** @type {HTMLButtonElement} */ ($('dbg-analyze'));
  const runBtn = /** @type {HTMLButtonElement} */ ($('dbg-ai-run'));
  const modelSel = /** @type {HTMLSelectElement} */ ($('dbg-ai-model'));
  const workspaceChk = /** @type {HTMLInputElement} */ ($('dbg-ai-workspace'));
  const orgChk = /** @type {HTMLInputElement} */ ($('dbg-ai-org'));
  const questionInput = /** @type {HTMLInputElement} */ ($('dbg-ai-question'));
  const outputEl = /** @type {HTMLPreElement} */ ($('dbg-ai-output'));
  const applyEl = $('dbg-apply-levels');
  const openMarkdownBtn = /** @type {HTMLButtonElement} */ ($('dbg-ai-open-markdown'));
  const saveBtn = /** @type {HTMLButtonElement} */ ($('dbg-ai-save'));
  const copyBtn = /** @type {HTMLButtonElement} */ ($('dbg-ai-copy'));

  /** @type {string | null} */ let opId = null;
  let analysis = '';
  /** @type {string} */ let pendingModelId = '';
  /** The log the current analysis belongs to, so it never leaks into another log's panel. */
  let analyzedLogId = '';

  wireCopyToClipboardButton(copyBtn, () => analysis);
  openMarkdownBtn.addEventListener('click', () => {
    // The analysis is Markdown — render it in VSCode's own preview (the same
    // global route the AI scripts use).
    if (!analysis) return;
    vscode.postMessage({
      type: 'openScriptResultMarkdown',
      content: analysis,
      scriptId: ctx.getLogId(),
      title: `Log analysis ${ctx.getLogId()}`,
    });
  });

  saveBtn.addEventListener('click', () => {
    if (!analysis) return;
    vscode.postMessage({
      type: 'saveApexLogAnalysis',
      logId: ctx.getLogId(),
      content: analysis,
    });
  });

  workspaceChk.addEventListener('change', () =>
    ctx.onStateChange({ allowWorkspaceFiles: workspaceChk.checked }),
  );
  orgChk.addEventListener('change', () => ctx.onStateChange({ allowOrgQueries: orgChk.checked }));
  modelSel.addEventListener('change', () => ctx.onStateChange({ modelId: modelSel.value }));

  /** Clear the streamed output and the level suggestion, keeping the toggles. */
  function clearOutput() {
    analysis = '';
    outputEl.textContent = '';
    applyEl.style.display = 'none';
    applyEl.innerHTML = '';
  }

  /** Stop an in-flight run and re-enable the button (no result will be shown). */
  function abortRun() {
    if (!opId) return;
    vscode.postMessage({ type: 'cancelOperation', opId });
    /** @type {any} */ (window).__endAction(opId);
    opId = null;
  }

  const isOpen = () => panel.style.display !== 'none';

  /** Reveal the settings + output panel (without running anything) and make it noticeable. */
  function openPanel() {
    panel.style.display = '';
    analyzeBtn.textContent = labels.analyzeClose;
    if (!analysis && !opId) outputEl.textContent = labels.aiIdleHint;
    scrollAndHighlight(document, '#dbg-ai', 'dbg-ai--highlight');
  }

  function closePanel() {
    panel.style.display = 'none';
    analyzeBtn.textContent = labels.analyzeOpen;
  }

  // "Analyze with AI" only opens the settings panel — it lets the user pick a
  // model, toggle tools, and describe what to focus on BEFORE anything runs.
  // Running the analysis is a separate, explicit action (dbg-ai-run below).
  analyzeBtn.addEventListener('click', () => {
    const logId = ctx.getLogId();
    if (!logId) return;
    if (isOpen()) closePanel();
    else openPanel();
  });

  runBtn.addEventListener('click', () => {
    const logId = ctx.getLogId();
    if (!logId) return;
    analyzedLogId = logId;
    clearOutput();
    const win = /** @type {any} */ (window);
    opId = win.__startAction(runBtn, () => {
      vscode.postMessage({ type: 'cancelOperation', opId });
    });
    vscode.postMessage({
      type: 'analyzeApexLog',
      opId,
      logId,
      question: questionInput.value.trim(),
      modelId: modelSel.value,
      allowWorkspaceFiles: workspaceChk.checked,
      allowOrgQueries: orgChk.checked,
    });
    outputEl.textContent = labels.analyzing;
    // Same re-anchor as the other AI panes: a re-run after the user scrolled
    // through a previous analysis would otherwise stream in off-screen.
    scrollToBottom(outputEl);
  });

  /**
   * Render the analysis, keeping the pane on the tail unless the user has
   * deliberately scrolled up.
   */
  function paint() {
    const wasAtBottom = isScrolledToBottom(outputEl);
    outputEl.textContent = analysis;
    stickToBottom(outputEl, wasAtBottom);
  }

  /** Offer to push the model's recommended levels back into the trace form. */
  function renderApplyLevels() {
    const suggestion = parseLevelSuggestion(analysis);
    if (!suggestion) {
      applyEl.style.display = 'none';
      return;
    }
    applyEl.style.display = '';
    applyEl.innerHTML = suggestion.reason
      ? `<span class="dbg-apply-reason">${escapeHtml(suggestion.reason)}</span>`
      : '';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-primary';
    button.textContent = labels.applyLevels;
    button.addEventListener('click', () => {
      ctx.onApplyLevels(suggestion);
      button.textContent = labels.appliedLevels;
      button.disabled = true;
    });
    applyEl.appendChild(button);
  }

  return {
    applyState(/** @type {any} */ state) {
      workspaceChk.checked = state.allowWorkspaceFiles !== false;
      orgChk.checked = !!state.allowOrgQueries;
      pendingModelId = state.modelId ?? '';
    },
    setModels(/** @type {any[]} */ models) {
      modelSel.innerHTML = '';
      const auto = document.createElement('option');
      auto.value = '';
      auto.textContent = labels.modelAuto;
      modelSel.appendChild(auto);
      for (const model of models ?? []) {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = model.name;
        modelSel.appendChild(option);
      }
      if (pendingModelId && models?.some((m) => m.id === pendingModelId)) {
        modelSel.value = pendingModelId;
      }
      if (!models?.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = labels.noModels;
        modelSel.appendChild(option);
      }
    },
    /** @param {string} chunk */
    appendChunk(chunk) {
      if (!analysis) outputEl.textContent = '';
      analysis += chunk;
      paint();
    },
    /** @param {any} data */
    finish(data) {
      const win = /** @type {any} */ (window);
      win.__endAction(opId);
      opId = null;
      if (data?.analysis && !analysis) {
        analysis = data.analysis;
        // A model that returned everything at once streamed no chunks, so this
        // is the only write — it still has to follow.
        paint();
      }
      renderApplyLevels();
    },
    /** @param {string} message */
    showError(message) {
      const win = /** @type {any} */ (window);
      win.__endAction(opId);
      opId = null;
      panel.style.display = '';
      analyzeBtn.textContent = labels.analyzeClose;
      outputEl.textContent = `${labels.analyzeFailed}: ${message}`;
    },
    getOpId: () => opId,
    /** The log the shown analysis belongs to ('' when there is none). */
    getAnalyzedLogId: () => analyzedLogId,
    /**
     * Called when a log is opened. An analysis belongs to one log, so opening a
     * different one drops it (cancelling a run still in flight); re-opening the
     * same log keeps what is already on screen.
     * @param {string} logId
     */
    resetFor(logId) {
      if (logId === analyzedLogId) return;
      abortRun();
      analyzedLogId = '';
      clearOutput();
      closePanel();
    },
    hide() {
      abortRun();
      analyzedLogId = '';
      clearOutput();
      closePanel();
    },
  };
}

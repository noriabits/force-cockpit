// @ts-check
// The SOQL tab's AI query generator panel. Hidden until the ✨ button reveals
// it (same open-then-run flow as the Debug Logs AI panel), then behaves like
// the Overview tab's chat: stream the model's reasoning into a running
// transcript, and offer the final query as a one-click "Run query".
//
// Streaming rides the shared `scriptLogChunk` channel, which fans out to every
// feature — hence the opId check on every message. Ids come from the shared
// action tracker (`op-N`, which also buys the spinner, the ✕ Cancel button and
// the operationStarted/Ended busy accounting), a namespace disjoint from the
// query runner's own `soql-N`, so tabs.findByOpId can never claim a reply meant
// for this panel.
import { wireCopyToClipboardButton } from '../../../shared/view/output-actions';
import {
  isScrolledToBottom,
  scrollAndHighlight,
  scrollToBottom,
  stickToBottom,
} from '../../../shared/view/scroll-highlight';

const win = /** @type {any} */ (window);

/**
 * @param {{
 *   vscode: { postMessage: (msg: any) => void },
 *   labels: any,
 *   getEditorContext: () => { query: string, useToolingApi: boolean, lastRun: any },
 *   onRunProposal: (query: string, useToolingApi: boolean) => void,
 * }} ctx
 */
export function createSoqlAiPanel(ctx) {
  const { vscode, labels, getEditorContext, onRunProposal } = ctx;
  const $ = (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id));

  const toggleBtn = /** @type {HTMLButtonElement} */ ($('btn-soql-ai'));
  const panelEl = /** @type {HTMLElement} */ ($('soql-ai'));
  const modelSel = /** @type {HTMLSelectElement} */ ($('soql-ai-model'));
  const newChatBtn = /** @type {HTMLButtonElement} */ ($('soql-ai-new'));
  const outputEl = /** @type {HTMLPreElement} */ ($('soql-ai-output'));
  const questionEl = /** @type {HTMLTextAreaElement} */ ($('soql-ai-question'));
  const sendBtn = /** @type {HTMLButtonElement} */ ($('soql-ai-send'));
  const proposalEl = /** @type {HTMLElement} */ ($('soql-ai-proposal'));
  const proposalTitleEl = /** @type {HTMLElement} */ ($('soql-ai-proposal-title'));
  const queryEl = /** @type {HTMLPreElement} */ ($('soql-ai-query'));
  const toolingNoteEl = /** @type {HTMLElement} */ ($('soql-ai-tooling-note'));
  const runBtn = /** @type {HTMLButtonElement} */ ($('soql-ai-run'));
  const copyBtn = /** @type {HTMLButtonElement} */ ($('soql-ai-copy'));

  /** The whole conversation as one running text block. */
  let transcript = '';
  /** @type {string | null} */
  let opId = null;
  /** @type {{ query: string, useToolingApi: boolean } | null} */
  let proposal = null;
  /** Whether the in-flight turn streamed anything (fallback if the answer arrives with none). */
  let receivedChunk = false;
  /** Model id from persisted state, re-applied once the model list lands. */
  let pendingModelId = '';
  let modelsLoaded = false;

  // ── Static wiring ───────────────────────────────────────────────────────────
  toggleBtn.textContent = labels.openPanel;
  sendBtn.textContent = labels.send;
  newChatBtn.textContent = labels.newChat;
  runBtn.textContent = labels.runQuery;
  copyBtn.textContent = labels.copy;
  proposalTitleEl.textContent = labels.proposalTitle;
  questionEl.placeholder = labels.placeholder;
  showIdleHintIfEmpty();

  wireCopyToClipboardButton(copyBtn, () => (proposal ? proposal.query : ''));

  toggleBtn.addEventListener('click', () => (isOpen() ? closePanel() : openPanel()));
  sendBtn.addEventListener('click', send);
  questionEl.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      send();
    }
  });
  newChatBtn.addEventListener('click', () => {
    if (opId) return; // disabled while running, but guard anyway
    vscode.postMessage({ type: 'resetSoqlAiChat' });
  });
  runBtn.addEventListener('click', () => {
    if (!proposal) return;
    onRunProposal(proposal.query, proposal.useToolingApi);
  });
  modelSel.addEventListener('change', () => {
    pendingModelId = modelSel.value;
  });

  // ── Panel visibility ────────────────────────────────────────────────────────
  function isOpen() {
    return panelEl.style.display !== 'none';
  }

  function openPanel() {
    panelEl.style.display = '';
    toggleBtn.textContent = labels.closePanel;
    if (!modelsLoaded) vscode.postMessage({ type: 'listChatModels' });
    // The panel sits below the editor and is easy to miss — flash it, the same
    // way the Debug Logs AI panel announces itself.
    scrollAndHighlight(document, '#soql-ai', 'soql-ai--highlight');
    questionEl.focus();
  }

  function closePanel() {
    // Deliberately does NOT abort an in-flight run: chunks keep landing in the
    // hidden output, so reopening mid-run shows whatever has streamed so far.
    panelEl.style.display = 'none';
    toggleBtn.textContent = labels.openPanel;
  }

  // ── Model picker ────────────────────────────────────────────────────────────
  /** @param {any[]} models */
  function setModels(models) {
    modelsLoaded = true;
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
    if (!models?.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = labels.noModels;
      modelSel.appendChild(option);
    }
    applyPendingModel();
  }

  function applyPendingModel() {
    if (pendingModelId && [...modelSel.options].some((o) => o.value === pendingModelId)) {
      modelSel.value = pendingModelId;
    }
  }

  // ── Transcript ──────────────────────────────────────────────────────────────
  function showIdleHintIfEmpty() {
    if (!transcript) outputEl.textContent = labels.emptyOutputHint;
  }

  /**
   * Render the transcript, keeping the pane on the tail unless the user has
   * deliberately scrolled up — every write during a run goes through here, so a
   * model that returns its whole answer in one go still follows.
   */
  function paint() {
    const wasAtBottom = isScrolledToBottom(outputEl);
    outputEl.textContent = transcript;
    stickToBottom(outputEl, wasAtBottom);
  }

  /** @param {string} chunk */
  function appendChunk(chunk) {
    receivedChunk = true;
    transcript += chunk;
    paint();
  }

  function resetChat() {
    transcript = '';
    proposal = null;
    outputEl.textContent = '';
    proposalEl.style.display = 'none';
    showIdleHintIfEmpty();
  }

  // ── Proposal card ───────────────────────────────────────────────────────────
  /** @param {any} next */
  function showProposal(next) {
    proposal = { query: next.query, useToolingApi: !!next.useToolingApi };
    queryEl.textContent = next.query;

    toolingNoteEl.textContent = labels.toolingNote;
    toolingNoteEl.style.display = next.useToolingApi ? '' : 'none';

    proposalEl.style.display = '';
  }

  // ── Run lifecycle ───────────────────────────────────────────────────────────
  function setBusy(/** @type {boolean} */ busy) {
    questionEl.disabled = busy;
    newChatBtn.disabled = busy;
    modelSel.disabled = busy;
  }

  function endRun() {
    win.__endAction(opId);
    opId = null;
    setBusy(false);
  }

  function send() {
    const question = questionEl.value.trim();
    if (!question || opId) return;
    if (!win.__orgConnected) {
      transcript += (transcript ? '\n\n' : '') + labels.notConnected + '\n';
      outputEl.textContent = transcript;
      return;
    }

    questionEl.value = '';
    receivedChunk = false;
    proposalEl.style.display = 'none';
    proposal = null;
    transcript += (transcript ? '\n\n---\n\n' : '') + '> ' + question + '\n\n';
    outputEl.textContent = transcript;
    // Re-anchor: the question we just wrote grew the pane without moving the
    // scroll position, so without this every stickToBottom check below reads
    // false and the answer streams in off-screen.
    scrollToBottom(outputEl);
    setBusy(true);

    opId = win.__startAction(sendBtn, () => {
      vscode.postMessage({ type: 'cancelOperation', opId });
    });
    // What is on screen goes with every turn, not just the first: the user may
    // edit the query or re-run it between questions, and requests like "why
    // does this fail" or "why is Amount empty here" only mean anything against
    // the current state.
    const editor = getEditorContext();
    vscode.postMessage({
      type: 'generateSoqlQuery',
      opId,
      question,
      modelId: modelSel.value,
      currentQuery: editor.query,
      currentUseToolingApi: editor.useToolingApi,
      lastRun: editor.lastRun,
    });
  }

  /** Abort an in-flight run and clear the thread — used on org change. */
  function cancelAndReset() {
    if (opId) {
      vscode.postMessage({ type: 'cancelOperation', opId });
      endRun();
    }
    resetChat();
  }

  // ── Host messages ───────────────────────────────────────────────────────────
  win.__onMessage('listChatModelsResult', (/** @type {any} */ msg) =>
    setModels(msg.data?.models ?? []),
  );
  win.__onMessage('listChatModelsError', () => setModels([]));

  // Shared streaming channel — only take chunks for our own run.
  win.__onMessage('scriptLogChunk', (/** @type {any} */ msg) => {
    if (msg.data?.opId && msg.data.opId === opId) appendChunk(msg.data.chunk);
  });

  win.__onMessage('soqlAiAnswer', (/** @type {any} */ msg) => {
    const data = msg.data ?? {};
    if (data.opId !== opId) return; // stale — cancelled or superseded run
    endRun();
    if (!receivedChunk && data.answer) transcript += data.answer;
    if (data.cancelled) {
      transcript += `\n${labels.cancelledNote}\n`;
    } else if (data.proposal) {
      showProposal(data.proposal);
    }
    paint();
  });

  win.__onMessage('soqlAiError', (/** @type {any} */ msg) => {
    const data = msg.data ?? {};
    if (data.opId !== opId) return;
    endRun();
    // textContent renders this verbatim — no escaping needed.
    transcript += `\n${labels.failed}: ${data.message}\n`;
    paint();
  });

  win.__onMessage('soqlAiChatReset', () => resetChat());

  return {
    /** Re-apply a persisted model pick (arrives with queryStateLoaded). */
    setModelId(/** @type {string} */ modelId) {
      pendingModelId = modelId ?? '';
      applyPendingModel();
    },
    /**
     * An org-to-org switch never fires a disconnect, so a run left in flight
     * would keep going and let its describes/probes hit the NEW org under the
     * old question's framing. Both edges call this.
     */
    onOrgChanged: cancelAndReset,
  };
}

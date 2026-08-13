// @ts-check
// The Overview tab's ad-hoc "Ask the AI" chat card. A multi-turn conversation:
// the host (AskAiService) keeps the ChatMessage[] thread alive across turns, so
// this webview only needs to stream chunks into a running transcript and post
// each new question — no client-side conversation state beyond the visible
// text. Bundled by esbuild (dist/features/overview/ask-ai/view.js) because it
// imports the shared ES-module helpers below.
import { wireCopyToClipboardButton } from '../../../shared/view/output-actions';
import {
  isScrolledToBottom,
  scrollToBottom,
  stickToBottom,
} from '../../../shared/view/scroll-highlight';
import { createAskAiHistory } from './history';

const win = /** @type {any} */ (window);
const vscode = win.__vscode;
const labels = win.AskAiLabels;

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

const modelSel = /** @type {HTMLSelectElement} */ ($('ask-ai-model'));
const workspaceChk = /** @type {HTMLInputElement} */ ($('ask-ai-workspace'));
const orgChk = /** @type {HTMLInputElement} */ ($('ask-ai-org'));
const outputEl = /** @type {HTMLPreElement} */ ($('ask-ai-output'));
const questionEl = /** @type {HTMLTextAreaElement} */ ($('ask-ai-question'));
const sendBtn = /** @type {HTMLButtonElement} */ ($('ask-ai-send'));
const newChatBtn = /** @type {HTMLButtonElement} */ ($('ask-ai-new'));
const openMarkdownBtn = /** @type {HTMLButtonElement} */ ($('ask-ai-open-markdown'));
const copyBtn = /** @type {HTMLButtonElement} */ ($('ask-ai-copy'));
const historyBtn = /** @type {HTMLButtonElement} */ ($('ask-ai-history-btn'));
const historyDropdown = /** @type {HTMLElement} */ ($('ask-ai-history-dropdown'));

/** The full conversation rendered as one Markdown string — also what Copy / Open as markdown export. */
let transcript = '';
/** @type {string | null} */
let opId = null;
/** @type {string} */
let pendingModelId = '';
/** Whether the in-flight turn has streamed any text yet (fallback if the final answer arrives with none). */
let receivedChunk = false;

wireCopyToClipboardButton(copyBtn, () => transcript);

const history = createAskAiHistory({
  buttonEl: historyBtn,
  dropdownEl: historyDropdown,
  vscode,
  onPick: (id) => {
    if (opId) return; // don't orphan an in-flight answer by switching threads mid-stream
    vscode.postMessage({ type: 'loadAskAiConversation', id });
  },
});

openMarkdownBtn.addEventListener('click', () => {
  if (!transcript) return;
  vscode.postMessage({
    type: 'openScriptResultMarkdown',
    content: transcript,
    scriptId: 'ask-ai',
    title: 'Ask the AI',
  });
});

function showIdleHintIfEmpty() {
  if (!transcript) outputEl.textContent = labels.emptyOutputHint;
}
showIdleHintIfEmpty();

function lockToggles() {
  workspaceChk.disabled = true;
  orgChk.disabled = true;
  win.__setTooltip(workspaceChk.parentElement, labels.lockedHint);
  win.__setTooltip(orgChk.parentElement, labels.lockedHint);
}

function unlockToggles() {
  workspaceChk.disabled = false;
  orgChk.disabled = false;
}

/** @param {any[]} models */
function setModels(models) {
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
  if (pendingModelId && models?.some((/** @type {any} */ m) => m.id === pendingModelId)) {
    modelSel.value = pendingModelId;
  }
  if (!models?.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = labels.noModels;
    modelSel.appendChild(option);
  }
}

/** @param {any} state */
function applyState(state) {
  workspaceChk.checked = state.allowWorkspaceFiles !== false;
  orgChk.checked = state.allowOrgQueries !== false;
  pendingModelId = state.modelId ?? '';
  // Models may already have loaded before this arrives — re-apply the pick.
  if (pendingModelId && [...modelSel.options].some((o) => o.value === pendingModelId)) {
    modelSel.value = pendingModelId;
  }
}

workspaceChk.addEventListener('change', () =>
  vscode.postMessage({
    type: 'saveAskAiState',
    patch: { allowWorkspaceFiles: workspaceChk.checked },
  }),
);
orgChk.addEventListener('change', () =>
  vscode.postMessage({ type: 'saveAskAiState', patch: { allowOrgQueries: orgChk.checked } }),
);
modelSel.addEventListener('change', () =>
  vscode.postMessage({ type: 'saveAskAiState', patch: { modelId: modelSel.value } }),
);

/**
 * Render the transcript, keeping the pane on the tail unless the user has
 * deliberately scrolled up — every write during a turn goes through here, so a
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

function setBusy(/** @type {boolean} */ busy) {
  questionEl.disabled = busy;
  newChatBtn.disabled = busy;
}

function resetChat() {
  transcript = '';
  outputEl.textContent = '';
  unlockToggles();
  showIdleHintIfEmpty();
}

function send() {
  const question = questionEl.value.trim();
  if (!question || opId) return;
  questionEl.value = '';
  receivedChunk = false;
  transcript += (transcript ? '\n\n---\n\n' : '') + '## You\n' + question + '\n\n## Assistant\n';
  outputEl.textContent = transcript;
  // Re-anchor: the turn header we just wrote grew the pane without moving the
  // scroll position, so without this every stickToBottom check below reads
  // false and the answer streams in off-screen.
  scrollToBottom(outputEl);
  setBusy(true);
  opId = win.__startAction(sendBtn, () => {
    vscode.postMessage({ type: 'cancelOperation', opId });
  });
  vscode.postMessage({
    type: 'askAiQuestion',
    opId,
    question,
    modelId: modelSel.value,
    allowWorkspaceFiles: workspaceChk.checked,
    allowOrgQueries: orgChk.checked,
  });
}

sendBtn.addEventListener('click', send);
questionEl.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    send();
  }
});

newChatBtn.addEventListener('click', () => {
  if (opId) return; // disabled while running, but guard anyway
  // Nothing to archive here — the host already saved every completed reply
  // to History as it happened (see askAiAnswer below), so this just clears
  // the live thread to start a new session.
  vscode.postMessage({ type: 'resetAskAiChat' });
});

/** Stop tracking an in-flight run locally (host-side cancellation/cleanup happens separately). */
function endRun() {
  win.__endAction(opId);
  opId = null;
  setBusy(false);
}

win.__registerFeature('ask-ai', {
  onOrgConnected() {
    // A direct org-to-org switch never fires onOrgDisconnected, so a run left
    // in flight from the previous org would otherwise keep going and let its
    // tool calls (run_soql/describe_object) silently query the NEW org under
    // the old question's framing. Cancel it the same way onOrgDisconnected does.
    if (opId) {
      vscode.postMessage({ type: 'cancelOperation', opId });
      endRun();
    }
    vscode.postMessage({ type: 'loadAskAiState' });
    vscode.postMessage({ type: 'listChatModels' });
    // History is global (not per-org) — refresh it here too, since the host
    // may have just archived the outgoing thread via connectionChanged.
    history.refresh();
    // The host resets the thread on every connection change (a new/rejoined
    // org invalidates prior tool results) — mirror that here.
    resetChat();
  },
  onOrgDisconnected() {
    if (opId) {
      vscode.postMessage({ type: 'cancelOperation', opId });
      endRun();
    }
    resetChat();
  },
  onMessage(/** @type {{ type: string, data: any }} */ message) {
    const data = message.data ?? {};
    switch (message.type) {
      case 'askAiStateLoaded':
        applyState(data.state ?? {});
        break;
      case 'listChatModelsResult':
        setModels(data.models ?? []);
        break;
      case 'listChatModelsError':
        setModels([]);
        break;

      // Shared streaming channel — only take chunks for our own run.
      case 'scriptLogChunk':
        if (data.opId && data.opId === opId) appendChunk(data.chunk);
        break;

      case 'askAiAnswer':
        if (data.opId !== opId) return; // stale — belongs to a cancelled/superseded run
        endRun();
        if (!receivedChunk && data.answer) {
          transcript += data.answer;
        }
        if (data.cancelled) {
          transcript += `\n${labels.cancelledNote}\n`;
        } else {
          lockToggles();
          // The host just saved/updated this conversation's History entry —
          // refresh so the dropdown shows it (and its bumped timestamp)
          // whenever it's next opened, without waiting for a reconnect.
          history.refresh();
        }
        paint();
        break;
      case 'askAiError':
        if (data.opId !== opId) return;
        endRun();
        // textContent renders this verbatim — no HTML escaping needed (that's
        // only for innerHTML sinks elsewhere in the codebase).
        transcript += `\n_${labels.askFailed}: ${data.message}_\n`;
        paint();
        break;

      case 'askAiChatReset':
        resetChat();
        break;

      case 'askAiHistoryLoaded':
        history.onHistoryUpdated(data.conversations ?? []);
        break;

      case 'askAiConversationLoaded':
        transcript = data.transcript ?? '';
        outputEl.textContent = transcript;
        pendingModelId = data.modelId ?? '';
        if (pendingModelId && [...modelSel.options].some((o) => o.value === pendingModelId)) {
          modelSel.value = pendingModelId;
        }
        // The restored thread's tool access is already committed host-side —
        // reflect that immediately rather than waiting for a new turn to lock it.
        lockToggles();
        if (data.messagesTruncated) {
          transcript += `\n\n_${labels.historyTruncatedNote}_\n`;
          outputEl.textContent = transcript;
        }
        break;
      case 'askAiConversationLoadedError':
        // Don't touch whatever is already on screen — there's nothing wrong
        // with the current transcript, only the load attempt failed.
        console.error('Failed to load conversation:', data.message);
        break;

      case 'askAiConversationDeleted':
        break; // history.js already removed it locally on click
      case 'askAiConversationDeleteError':
        history.refresh(); // resync — the optimistic local removal may be wrong
        break;
    }
  },
});

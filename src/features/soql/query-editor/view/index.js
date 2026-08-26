// @ts-check
// SOQL query editor on the SOQL tab — orchestrator. Wires:
//   - the shared textarea + Run/Clear + Cmd/Ctrl+Enter shortcut + Tooling toggle
//   - the results table (filter, sortable columns, clickable record Ids, export)
//   - multiple query tabs (tabs.js) with per-tab in-memory results
// Bundled by esbuild into dist/features/soql/query-editor/view.js. Registers via
// win.__onMessage and exposes win.__clearQueryResults for org-lifecycle.js.
import { createResultsTable } from './results-table';
import { toCsv, toJson } from './export-format';
import { createQueryTabs } from './tabs';
import { createQueryHistory } from './history';
import { createDescribeCache } from './autocomplete/describe-cache';
import { createAutocomplete } from './autocomplete/autocomplete';
import { createSoqlHighlighter } from './highlight/highlighter';
import { createQueryErrorView } from './error-view';
import { capitalizeKeywordEndingAt } from './keyword-case';
import { createSoqlAiPanel } from './ai-panel';
import { MAX_RESULT_ROWS } from '../ai/requestMessage';

const win = /** @type {any} */ (window);
const vscode = win.__vscode;

const soqlInput = /** @type {HTMLTextAreaElement} */ (document.getElementById('soql-input'));
const btnRunQuery = /** @type {HTMLButtonElement} */ (document.getElementById('btn-run-query'));
const btnClearQuery = /** @type {HTMLButtonElement} */ (document.getElementById('btn-clear-query'));
const toolingCheckbox = /** @type {HTMLInputElement} */ (
  document.getElementById('query-use-tooling')
);
const tabBarEl = /** @type {HTMLElement} */ (document.getElementById('query-tab-bar'));
const queryHint = /** @type {HTMLElement} */ (document.getElementById('query-hint'));
const queryResults = /** @type {HTMLElement} */ (document.getElementById('query-results'));
const resultsMeta = /** @type {HTMLElement} */ (document.getElementById('results-meta'));
const resultsThead = /** @type {HTMLElement} */ (document.getElementById('results-thead'));
const resultsTbody = /** @type {HTMLElement} */ (document.getElementById('results-tbody'));
const queryError = /** @type {HTMLElement} */ (document.getElementById('query-error'));
const filterInput = /** @type {HTMLInputElement} */ (document.getElementById('query-filter-input'));
const counterEl = /** @type {HTMLElement} */ (document.getElementById('query-match-count'));
const btnExportCsv = /** @type {HTMLButtonElement} */ (document.getElementById('btn-export-csv'));
const btnExportJson = /** @type {HTMLButtonElement} */ (document.getElementById('btn-export-json'));
const btnHistory = /** @type {HTMLButtonElement} */ (document.getElementById('btn-query-history'));
const historyDropdown = /** @type {HTMLElement} */ (
  document.getElementById('query-history-dropdown')
);
const btnSaveQuery = /** @type {HTMLButtonElement} */ (document.getElementById('btn-save-query'));
const btnCloneQuery = /** @type {HTMLButtonElement} */ (document.getElementById('btn-clone-query'));
const autocompleteEl = /** @type {HTMLElement} */ (document.getElementById('query-autocomplete'));
const highlightEl = /** @type {HTMLElement} */ (document.getElementById('soql-highlight'));

// Auto-uppercase SOQL keywords (SELECT, FROM, WHERE, AND, ...) as the user
// finishes typing them. Registered before the highlighter/autocomplete/tabs
// listeners below so they all observe the already-uppercased text: listeners on
// the same event fire synchronously in registration order, and setRangeText
// mutates textarea.value in place without dispatching a second `input` event.
const BOUNDARY_CHARS = new Set([' ', '\t', '\n', ',', '(', ')']);
function maybeCapitalizeKeyword() {
  const cursor = soqlInput.selectionStart;
  if (!cursor || !BOUNDARY_CHARS.has(soqlInput.value[cursor - 1])) return;
  const found = capitalizeKeywordEndingAt(soqlInput.value, cursor - 1);
  if (!found) return;
  soqlInput.setRangeText(found.word, found.start, found.end, 'preserve');
  soqlInput.setSelectionRange(cursor, cursor);
}
soqlInput.addEventListener('input', maybeCapitalizeKeyword);
// Catches a trailing keyword with no delimiter after it yet (e.g. a query ending
// in "...LIMIT" when the user tabs away or clicks Run). Not part of the `input`
// cascade above, so it re-syncs the highlighter/tab state itself.
soqlInput.addEventListener('blur', () => {
  const found = capitalizeKeywordEndingAt(soqlInput.value, soqlInput.value.length);
  if (!found) return;
  const cursor = soqlInput.selectionStart;
  soqlInput.setRangeText(found.word, found.start, found.end, 'preserve');
  soqlInput.setSelectionRange(cursor, cursor);
  highlighter.refresh();
  tabs.onActiveEdited();
});

// Syntax-highlight overlay. `refresh()` must be called from every site that writes
// soqlInput.value programmatically — those never fire an `input` event.
const highlighter = createSoqlHighlighter({ textarea: soqlInput, overlayEl: highlightEl });

const table = createResultsTable({
  thead: resultsThead,
  tbody: resultsTbody,
  meta: resultsMeta,
  filterInput,
  counterEl,
  vscode,
  escapeHtml: win.__escapeHtml,
});

const errorView = createQueryErrorView({ errorEl: queryError });

// ── Results display ───────────────────────────────────────────────────────────
function hideResults() {
  queryResults.style.display = 'none';
  errorView.hide();
  table.clear();
}

/** @param {{ records: any[], totalSize: number }} data */
function showResults(data) {
  errorView.hide();
  table.setData(data.records, data.totalSize);
  queryResults.style.display = '';
}

/** @param {{ message: string, diagnostics?: any }} error */
function showError(error) {
  queryResults.style.display = 'none';
  table.clear();
  errorView.show(error.message, error.diagnostics);
}

/**
 * Paint the tab's stored outcome. A query that finishes while the user is on a
 * different tab settles silently onto its own tab; this is where it surfaces.
 * @param {any} tab
 */
function renderTabOutput(tab) {
  if (tab && tab.results) showResults(tab.results);
  else if (tab && tab.error) showError(tab.error);
  else hideResults();
}

// The ✕ Cancel button injected next to Run while a query is in flight — same
// look as media/modules/action-tracker.js (.btn.running spinner + .action-cancel-btn),
// reimplemented locally because that helper binds one opId to one button for its
// whole lifetime; our Run button is shared and reassigned across tabs, so the
// cancel control has to be re-created/torn down on every switch instead.
/** @type {HTMLButtonElement | null} */
let queryCancelBtn = null;

/**
 * The single place that drives the shared Run button + hint. They serve every
 * tab, so they must always reflect the *active* tab's run — never whichever
 * run finished last.
 * @param {any} tab
 */
function paintRunState(tab) {
  const running = !!(tab && tab.opId);
  btnRunQuery.disabled = running;
  btnRunQuery.classList.toggle('running', running);
  queryHint.textContent = running ? 'Running…' : '';

  if (running && !queryCancelBtn) {
    queryCancelBtn = document.createElement('button');
    queryCancelBtn.type = 'button';
    queryCancelBtn.className = 'btn btn-ghost action-cancel-btn';
    queryCancelBtn.textContent = '✕ Cancel';
    queryCancelBtn.addEventListener('click', () => {
      const activeTab = tabs.getActive();
      stopRun(tabs.getActiveOpId());
      tabs.setActiveOpId(null);
      paintRunState(activeTab);
    });
    btnRunQuery.parentElement?.insertBefore(queryCancelBtn, btnRunQuery.nextSibling);
  } else if (!running && queryCancelBtn) {
    queryCancelBtn.remove();
    queryCancelBtn = null;
  }
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
const tabs = createQueryTabs({
  tabBarEl,
  textarea: soqlInput,
  toolingCheckbox,
  vscode,
  onActivate: (tab) => {
    // Every tab switch/add/close/load pushes the tab's text into the textarea
    // without an `input` event, so re-highlight here.
    highlighter.refresh();
    renderTabOutput(tab);
    paintRunState(tab);
  },
  onTabClosed: (tab) => stopRun(tab.opId),
});

// The tabs factory hydrates the textarea once at construction time, before any
// onActivate fires.
highlighter.refresh();

/**
 * Overwrite the active tab's editor with a query. The AI panel's handoff path —
 * a History pick goes through `tabs.openQuery` instead, which opens its own tab.
 * @param {string} query @param {boolean} useToolingApi
 */
function replaceActiveQuery(query, useToolingApi) {
  soqlInput.value = query;
  toolingCheckbox.checked = !!useToolingApi;
  tabs.onActiveEdited();
  highlighter.refresh();
}

// ── History ───────────────────────────────────────────────────────────────────
const history = createQueryHistory({
  buttonEl: btnHistory,
  dropdownEl: historyDropdown,
  saveBtn: btnSaveQuery,
  vscode,
  getCurrent: () => ({ query: soqlInput.value, useToolingApi: toolingCheckbox.checked }),
  // Its own tab (or a pristine active one), so a pick never destroys open work.
  onPick: (entry) => tabs.openQuery(entry),
});

// ── Autocomplete ──────────────────────────────────────────────────────────────
const describeCache = createDescribeCache({ vscode });
createAutocomplete({
  textarea: soqlInput,
  dropdownEl: autocompleteEl,
  describeCache,
  isConnected: () => !!win.__orgConnected,
  onInsert: () => {
    // setRangeText doesn't fire an `input` event, so the highlighter never
    // sees the insertion on its own — refresh it explicitly (same reason
    // every other programmatic textarea.value write in this file does).
    highlighter.refresh();
    tabs.onActiveEdited();
  },
});

// ── Run tracking ──────────────────────────────────────────────────────────────
// Each run gets an id, held by the tab that started it (tabs.js owns that field).
// The reply is routed back by that id, so a run always settles on its own tab —
// and a reply whose tab has been closed or stopped finds no owner and is dropped.
// The prefix keeps this id space disjoint from action-tracker.js's 'op-N'.
let opSeq = 0;
/** @type {Map<string, { soql: string, useToolingApi: boolean }>} what each in-flight run asked for */
const pendingRuns = new Map();

/**
 * Stop one run: tell the host to abort it and release the webview-side bookkeeping.
 * Clearing the tab's opId (done by the caller, or here for the active tab) is what
 * makes any late reply undeliverable.
 * @param {string | null | undefined} opId
 */
function stopRun(opId) {
  if (!opId) return;
  pendingRuns.delete(opId);
  vscode.postMessage({ type: 'cancelOperation', opId });
  vscode.postMessage({ type: 'operationEnded', opId });
}

/** Abort every in-flight run and reset the toolbar (org disconnect, bulk cancel). */
function stopAllRuns() {
  for (const opId of tabs.getRunningOpIds()) stopRun(opId);
  tabs.clearAllOpIds();
  paintRunState(tabs.getActive());
}

// Clear the visible results on disconnect (the active tab's in-memory results
// stay until the next run overwrites them). Any in-flight query is abandoned —
// its answer would come from an org we are no longer connected to. Also drop the
// describe cache so a new org re-describes its own schema.
win.__clearQueryResults = () => {
  stopAllRuns();
  hideResults();
  describeCache.clear();
  aiPanel.onOrgChanged();
};

// Runs alongside action-tracker.js's own handler — __onMessage keeps a Set of
// handlers per type, so both fire.
win.__onMessage('cancelAllOperations', () => stopAllRuns());

// ── Message handlers ────────────────────────────────────────────────────────
/**
 * Resolve a reply to the tab that started it. Returns null when that tab is gone
 * (closed, stopped, or superseded), meaning the reply must be discarded.
 * @param {any} msg
 */
function ownerOf(msg) {
  const opId = msg.data?.opId;
  const tab = tabs.findByOpId(opId);
  if (opId) vscode.postMessage({ type: 'operationEnded', opId });
  if (!tab) return null;
  return { tab, opId };
}

win.__onMessage('queryResult', (/** @type {any} */ msg) => {
  const owner = ownerOf(msg);
  if (!owner) return;
  const { tab, opId } = owner;
  tabs.settleRun(tab, msg.data, null);

  const run = pendingRuns.get(opId);
  pendingRuns.delete(opId);
  if (run) history.recordRun(run.soql, run.useToolingApi);

  // A background tab's results are stored only; onActivate paints them later.
  if (tab !== tabs.getActive()) return;
  showResults(msg.data);
  paintRunState(tab);
});

win.__onMessage('queryError', (/** @type {any} */ msg) => {
  const owner = ownerOf(msg);
  if (!owner) return;
  const { tab, opId } = owner;
  tabs.settleRun(tab, null, {
    message: msg.data.message,
    diagnostics: msg.data.diagnostics,
    // Kept for the AI panel: the editor may have moved on since this failed.
    soql: msg.data.soql,
  });
  pendingRuns.delete(opId);

  if (tab !== tabs.getActive()) return;
  showError(msg.data);
  paintRunState(tab);
});

win.__onMessage('queryStateLoaded', (/** @type {any} */ msg) => {
  tabs.load(msg.data);
  history.load(msg.data);
  aiPanel.setModelId(msg.data.aiModelId ?? '');
});

win.__onMessage('queryHistoryUpdated', (/** @type {any} */ msg) => {
  history.onHistoryUpdated(msg.data.history);
});

win.__onMessage('savedQueriesUpdated', (/** @type {any} */ msg) => {
  history.onSavedUpdated(msg.data.savedQueries);
});

win.__onMessage('describeGlobalResult', (/** @type {any} */ msg) => {
  describeCache.onGlobalResult(msg.data);
});

win.__onMessage('describeSObjectResult', (/** @type {any} */ msg) => {
  describeCache.onSObjectResult(msg.data.name, msg.data);
});

win.__onMessage('describeError', (/** @type {any} */ msg) => {
  describeCache.onError(msg.data);
});

// ── Button + input handlers ───────────────────────────────────────────────────
/**
 * Run whatever the active tab currently holds. Shared by the Run button and the
 * AI panel's "Run query" (which fills the active tab first), so the opId
 * bookkeeping and busy announcement live in exactly one place.
 */
function runActiveQuery() {
  const soql = soqlInput.value.trim();
  if (!soql) return;
  if (!win.__orgConnected) {
    errorView.show('Not connected to any org.');
    return;
  }

  const useToolingApi = toolingCheckbox.checked;
  const opId = 'soql-' + ++opSeq;

  hideResults();
  // Drop the previous outcome now, so switching away mid-run doesn't come back
  // to a stale result or error sitting under a "Running…" toolbar.
  tabs.setActiveResults(null);
  pendingRuns.set(opId, { soql, useToolingApi });
  tabs.setActiveOpId(opId);
  paintRunState(tabs.getActive());
  vscode.postMessage({ type: 'query', soql, useToolingApi, opId });
  // Announce the run so the host counts it as busy — that is what makes an org
  // switch warn instead of silently pulling the connection out from under it.
  vscode.postMessage({ type: 'operationStarted', opId });
}

btnRunQuery.addEventListener('click', runActiveQuery);

/**
 * The active tab's last outcome, sampled down before it crosses postMessage — a
 * full result set can be 2000 rows and none of it needs to travel. Returns null
 * when the tab has neither run yet nor failed.
 */
function activeTabLastRun() {
  const tab = tabs.getActive();
  if (!tab) return null;
  if (tab.error) {
    return { query: tab.error.soql, error: tab.error.message };
  }
  if (!tab.results) return null;
  // settleRun stores the whole queryResult payload, so the query that actually
  // produced these rows rides along with them — the editor may have moved on.
  return {
    query: tab.results.soql,
    useToolingApi: tab.results.useToolingApi,
    records: (tab.results.records ?? []).slice(0, MAX_RESULT_ROWS),
    totalSize: tab.results.totalSize,
  };
}

// ── AI query generator ────────────────────────────────────────────────────────
const aiPanel = createSoqlAiPanel({
  vscode,
  labels: win.SoqlAiLabels,
  // Sent with every question: most requests here are about what the user
  // already has open ("why doesn't this work", "why is Amount empty here").
  getEditorContext: () => ({
    query: soqlInput.value,
    useToolingApi: toolingCheckbox.checked,
    lastRun: activeTabLastRun(),
  }),
  onRunProposal: (query, useToolingApi) => {
    // Into the active tab — the request is usually about the query already open,
    // so a new tab would orphan the thing being iterated on (unlike a History
    // pick). Then the ordinary run path, indistinguishable from typing it by hand.
    replaceActiveQuery(query, useToolingApi);
    runActiveQuery();
  },
});

// An org-to-org switch never fires a disconnect, so both edges must reach the
// panel: a run left in flight would otherwise query the NEW org under the old
// question's framing.
win.__onMessage('orgConnected', () => aiPanel.onOrgChanged());

btnClearQuery.addEventListener('click', () => {
  soqlInput.value = '';
  tabs.onActiveEdited();
  highlighter.refresh();
  hideResults();
  tabs.setActiveResults(null);
});

btnCloneQuery.addEventListener('click', () => tabs.cloneActive());

soqlInput.addEventListener('input', () => tabs.onActiveEdited());
toolingCheckbox.addEventListener('change', () => tabs.onActiveEdited());

/** @param {'csv' | 'json'} format */
function exportResults(format) {
  const { cols, rows } = table.getView();
  if (cols.length === 0) return;
  const content = format === 'csv' ? toCsv(cols, rows) : toJson(cols, rows);
  vscode.postMessage({ type: 'exportQueryResult', content, format });
}

btnExportCsv.addEventListener('click', () => exportResults('csv'));
btnExportJson.addEventListener('click', () => exportResults('json'));

soqlInput.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    btnRunQuery.click();
  }
});

// Load persisted tabs/state once the bundle is live.
vscode.postMessage({ type: 'loadQueryState' });

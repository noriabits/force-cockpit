// @ts-check
// SOQL Quick Query editor on the Overview tab — orchestrator. Wires:
//   - the shared textarea + Run/Clear + Cmd/Ctrl+Enter shortcut + Tooling toggle
//   - the results table (filter, sortable columns, clickable record Ids, export)
//   - multiple query tabs (tabs.js) with per-tab in-memory results
// Bundled by esbuild into dist/webview/query-editor.js. Registers via
// win.__onMessage and exposes win.__clearQueryResults for org-lifecycle.js.
import { createResultsTable } from './results-table';
import { toCsv, toJson } from './export-format';
import { createQueryTabs } from './tabs';
import { createQueryHistory } from './history';
import { createDescribeCache } from './autocomplete/describe-cache';
import { createAutocomplete } from './autocomplete/autocomplete';

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
const autocompleteEl = /** @type {HTMLElement} */ (document.getElementById('query-autocomplete'));

const table = createResultsTable({
  thead: resultsThead,
  tbody: resultsTbody,
  meta: resultsMeta,
  filterInput,
  counterEl,
  vscode,
  escapeHtml: win.__escapeHtml,
});

// ── Results display ───────────────────────────────────────────────────────────
function hideResults() {
  queryResults.style.display = 'none';
  queryError.style.display = 'none';
  table.clear();
}

/** @param {{ records: any[], totalSize: number }} data */
function showResults(data) {
  queryError.style.display = 'none';
  table.setData(data.records, data.totalSize);
  queryResults.style.display = '';
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
const tabs = createQueryTabs({
  tabBarEl,
  textarea: soqlInput,
  toolingCheckbox,
  vscode,
  onActivate: (tab) => {
    // Render the activated tab's stored results, or clear if it has none.
    if (tab && tab.results) showResults(tab.results);
    else hideResults();
  },
});

/** Load a query (from history/saved) into the active tab's editor. */
function loadQueryIntoEditor(/** @type {{ query: string, useToolingApi: boolean }} */ entry) {
  soqlInput.value = entry.query;
  toolingCheckbox.checked = !!entry.useToolingApi;
  tabs.onActiveEdited();
}

// ── History ───────────────────────────────────────────────────────────────────
const history = createQueryHistory({
  buttonEl: btnHistory,
  dropdownEl: historyDropdown,
  saveBtn: btnSaveQuery,
  vscode,
  getCurrent: () => ({ query: soqlInput.value, useToolingApi: toolingCheckbox.checked }),
  onPick: loadQueryIntoEditor,
});

// ── Autocomplete ──────────────────────────────────────────────────────────────
const describeCache = createDescribeCache({ vscode });
createAutocomplete({
  textarea: soqlInput,
  dropdownEl: autocompleteEl,
  describeCache,
  isConnected: () => !!win.__orgConnected,
  onInsert: () => tabs.onActiveEdited(),
});

// Clear the visible results on disconnect (the active tab's in-memory results
// stay until the next run overwrites them). Also drop the describe cache so a
// new org re-describes its own schema.
win.__clearQueryResults = () => {
  hideResults();
  describeCache.clear();
};

/** @type {{ soql: string, useToolingApi: boolean } | null} */
let lastRun = null;

// ── Message handlers ────────────────────────────────────────────────────────
win.__onMessage('queryResult', (/** @type {any} */ msg) => {
  btnRunQuery.disabled = false;
  queryHint.textContent = '';
  tabs.setActiveResults(msg.data);
  showResults(msg.data);
  if (lastRun) history.recordRun(lastRun.soql, lastRun.useToolingApi);
});

win.__onMessage('queryError', (/** @type {any} */ msg) => {
  btnRunQuery.disabled = false;
  queryHint.textContent = '';
  queryResults.style.display = 'none';
  tabs.setActiveResults(null);
  queryError.textContent = msg.data.message;
  queryError.style.display = '';
});

win.__onMessage('queryStateLoaded', (/** @type {any} */ msg) => {
  tabs.load(msg.data);
  history.load(msg.data);
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
btnRunQuery.addEventListener('click', () => {
  const soql = soqlInput.value.trim();
  if (!soql) return;
  if (!win.__orgConnected) {
    queryError.textContent = 'Not connected to any org.';
    queryError.style.display = '';
    return;
  }

  hideResults();
  btnRunQuery.disabled = true;
  queryHint.textContent = 'Running…';
  lastRun = { soql, useToolingApi: toolingCheckbox.checked };
  vscode.postMessage({ type: 'query', soql, useToolingApi: toolingCheckbox.checked });
});

btnClearQuery.addEventListener('click', () => {
  soqlInput.value = '';
  tabs.onActiveEdited();
  hideResults();
  tabs.setActiveResults(null);
});

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

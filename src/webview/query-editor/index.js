// @ts-check
// SOQL Quick Query editor on the Overview tab:
//   - textarea + Run/Clear buttons + keyboard shortcut (Cmd/Ctrl+Enter)
//   - results table with filter, sortable columns, clickable record Ids
//   - export the current (filtered + sorted) view to a CSV/JSON file
// Bundled by esbuild into dist/webview/query-editor.js. Registers via
// win.__onMessage and exposes win.__clearQueryResults for org-lifecycle.js.
import { createResultsTable } from './results-table';
import { toCsv, toJson } from './export-format';

const win = /** @type {any} */ (window);
const vscode = win.__vscode;

const soqlInput = /** @type {HTMLTextAreaElement} */ (document.getElementById('soql-input'));
const btnRunQuery = /** @type {HTMLButtonElement} */ (document.getElementById('btn-run-query'));
const btnClearQuery = /** @type {HTMLButtonElement} */ (document.getElementById('btn-clear-query'));
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

const table = createResultsTable({
  thead: resultsThead,
  tbody: resultsTbody,
  meta: resultsMeta,
  filterInput,
  counterEl,
  vscode,
  escapeHtml: win.__escapeHtml,
});

function clearResults() {
  queryResults.style.display = 'none';
  queryError.style.display = 'none';
  table.clear();
}

// Expose for org-lifecycle.js to clear on disconnect.
win.__clearQueryResults = clearResults;

/** @param {{ records: any[], totalSize: number }} data */
function renderQueryResults(data) {
  queryError.style.display = 'none';
  table.setData(data.records, data.totalSize);
  queryResults.style.display = '';
}

// ── Message handlers ────────────────────────────────────────────────────────
win.__onMessage('queryResult', (/** @type {any} */ msg) => {
  btnRunQuery.disabled = false;
  queryHint.textContent = '';
  renderQueryResults(msg.data);
});

win.__onMessage('queryError', (/** @type {any} */ msg) => {
  btnRunQuery.disabled = false;
  queryHint.textContent = '';
  queryResults.style.display = 'none';
  queryError.textContent = msg.data.message;
  queryError.style.display = '';
});

// ── Button handlers ─────────────────────────────────────────────────────────
btnRunQuery.addEventListener('click', () => {
  const soql = soqlInput.value.trim();
  if (!soql) return;
  if (!win.__orgConnected) {
    queryError.textContent = 'Not connected to any org.';
    queryError.style.display = '';
    return;
  }

  clearResults();
  btnRunQuery.disabled = true;
  queryHint.textContent = 'Running…';
  vscode.postMessage({ type: 'query', soql });
});

btnClearQuery.addEventListener('click', () => {
  soqlInput.value = '';
  clearResults();
});

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

// @ts-check
// Results table for the Overview Quick Query: owns the render state (cols, rows,
// filter text, sort col/dir) and rebuilds the table on filter/sort. Reuses the
// pure filterRows/sortRows helpers and the record-id detector so a query result
// gets the same sort + filter + clickable-Id behaviour as the monitoring tables.
import { filterRows, sortRows } from '../../features/shared/view/table-sort';
import { isSalesforceRecordId } from '../../utils/salesforce';
import { toQuotedInList } from './export-format';

/**
 * @typedef {Object} ResultsTableCtx
 * @property {HTMLElement} thead
 * @property {HTMLElement} tbody
 * @property {HTMLElement} meta
 * @property {HTMLInputElement} filterInput
 * @property {HTMLElement} counterEl
 * @property {{ postMessage: (msg: any) => void }} vscode
 * @property {(str: any) => string} escapeHtml
 */

/**
 * @param {ResultsTableCtx} ctx
 */
export function createResultsTable(ctx) {
  const { thead, tbody, meta, filterInput, counterEl, vscode, escapeHtml } = ctx;

  /** @type {string[]} */
  let cols = [];
  /** @type {(string | null)[][]} */
  let rows = [];
  let totalSize = 0;
  let sortCol = -1;
  let sortAsc = true;

  // ── Cell rendering ────────────────────────────────────────────────────────
  /** @param {string | null} cell */
  function cellHtml(cell) {
    if (cell == null) return '<em style="opacity:0.5">null</em>';
    if (isSalesforceRecordId(cell)) {
      return `<a href="#" class="query-record-link" data-record-id="${escapeHtml(cell)}">${escapeHtml(cell)}</a>`;
    }
    // JSON.stringify output of relationship objects/subquery arrays. Re-wrap via
    // String() because isSalesforceRecordId's `value is string` predicate narrows
    // `cell` to `never` in this else branch (it subtracts `string` from the
    // already-`string` `cell`) — a // @ts-check quirk; the value is still a string.
    const trimmed = String(cell).trim();
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      return `<code>${escapeHtml(cell)}</code>`;
    }
    return escapeHtml(cell);
  }

  // ── Render ────────────────────────────────────────────────────────────────
  /**
   * Copy a column's current (filtered + sorted) values as a quoted IN-list.
   * @param {number} colIndex
   * @param {HTMLButtonElement} btn
   */
  function copyColumn(colIndex, btn) {
    const view = getView();
    const list = toQuotedInList(view.rows.map((r) => r[colIndex]));
    navigator.clipboard
      .writeText(list)
      .then(() => {
        const prev = btn.textContent;
        btn.textContent = '✓';
        setTimeout(() => {
          btn.textContent = prev;
        }, 1200);
      })
      .catch(() => {});
  }

  function renderHeader() {
    const tr = document.createElement('tr');
    cols.forEach((col, i) => {
      const th = document.createElement('th');
      th.className = 'query-sortable-th';

      const label = document.createElement('span');
      label.className = 'query-th-label';
      const arrow = sortCol === i ? (sortAsc ? ' ▲' : ' ▼') : '';
      label.textContent = col + arrow;
      label.addEventListener('click', () => {
        if (sortCol === i) {
          sortAsc = !sortAsc;
        } else {
          sortCol = i;
          sortAsc = true;
        }
        renderHeader();
        applyFilterAndSort();
      });

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'query-col-copy';
      copyBtn.textContent = '⧉';
      copyBtn.title = "Copy column as 'a', 'b', … for an IN (…) clause";
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        copyColumn(i, copyBtn);
      });

      th.appendChild(label);
      th.appendChild(copyBtn);
      tr.appendChild(th);
    });
    thead.innerHTML = '';
    thead.appendChild(tr);
  }

  function applyFilterAndSort() {
    const q = filterInput.value.trim();
    const filtered = filterRows(rows, q);
    const ordered = sortRows(filtered, sortCol, sortAsc);

    tbody.innerHTML = '';
    for (const row of ordered) {
      const tr = document.createElement('tr');
      for (const cell of row) {
        const td = document.createElement('td');
        td.innerHTML = cellHtml(cell);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }

    counterEl.textContent = q ? `${ordered.length} of ${rows.length}` : '';
  }

  // ── Public API ────────────────────────────────────────────────────────────
  /**
   * @param {any[]} records
   * @param {number} size
   */
  function setData(records, size) {
    totalSize = size;
    sortCol = -1;
    sortAsc = true;
    filterInput.value = '';
    counterEl.textContent = '';

    if (!records || records.length === 0) {
      cols = [];
      rows = [];
      thead.innerHTML = '';
      tbody.innerHTML = '';
      // SELECT COUNT() returns no rows but a real totalSize.
      meta.textContent = totalSize > 0 ? `Count: ${totalSize}` : 'Query returned 0 records.';
      return;
    }

    cols = Object.keys(records[0]).filter((k) => k !== 'attributes');
    rows = records.map((record) =>
      cols.map((col) => {
        const val = record[col];
        if (val == null) return null;
        if (typeof val === 'object') return JSON.stringify(val);
        return String(val);
      }),
    );

    meta.textContent = `${totalSize} record${totalSize !== 1 ? 's' : ''} (showing ${records.length})`;
    renderHeader();
    applyFilterAndSort();
  }

  function clear() {
    cols = [];
    rows = [];
    totalSize = 0;
    sortCol = -1;
    sortAsc = true;
    filterInput.value = '';
    counterEl.textContent = '';
    thead.innerHTML = '';
    tbody.innerHTML = '';
    meta.textContent = '';
  }

  /** Current filtered + sorted view, for export. @returns {{ cols: string[], rows: (string | null)[][] }} */
  function getView() {
    const filtered = filterRows(rows, filterInput.value.trim());
    return { cols, rows: sortRows(filtered, sortCol, sortAsc) };
  }

  // Filter input + delegated record-link clicks.
  filterInput.addEventListener('input', applyFilterAndSort);
  tbody.addEventListener('click', (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    if (target.tagName === 'A' && target.classList.contains('query-record-link')) {
      event.preventDefault();
      const recordId = target.getAttribute('data-record-id');
      if (recordId) vscode.postMessage({ type: 'openRecord', recordId });
    }
  });

  return { setData, clear, getView };
}

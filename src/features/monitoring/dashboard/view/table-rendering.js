// @ts-check
// HTML-table rendering for the monitoring dashboard: header build, sort headers,
// per-table filter + `X of Y` match counter, and record-id link cells. The
// render-state stash (`wrapper._tableState`) drives both the filter input and
// sort-header clicks, so the filter text + sort persist across auto-refresh.
import { isSalesforceRecordId } from '../../../../utils/salesforce';
import { filterRows, sortRows } from './table-sort';

/**
 * @typedef {Object} TableRendererCtx
 * @property {HTMLElement} grid
 * @property {any} labels
 * @property {(configId: string, text: string) => void} setCardStatus
 * @property {{ postMessage: (msg: any) => void }} vscode
 */

/**
 * @param {TableRendererCtx} ctx
 */
export function createTableRenderer(ctx) {
  const { grid, labels: L, setCardStatus, vscode } = ctx;
  const win = /** @type {any} */ (window);

  /**
   * @param {HTMLElement} tbody
   * @param {string[][]} rows
   * @param {number} sortCol
   * @param {boolean} sortAsc
   */
  function renderRows(tbody, rows, sortCol, sortAsc) {
    const sorted = sortRows(rows, sortCol, sortAsc);
    tbody.innerHTML = '';
    for (const row of sorted) {
      const tr = document.createElement('tr');
      for (const cell of row) {
        const td = document.createElement('td');
        td.className = 'monitoring-table-td';
        if (isSalesforceRecordId(cell)) {
          const a = document.createElement('a');
          a.className = 'monitoring-record-link';
          a.href = '#';
          a.dataset.recordId = cell;
          a.textContent = cell;
          td.appendChild(a);
        } else {
          td.textContent = cell;
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
  }

  /**
   * @param {HTMLElement} wrapper
   */
  function applyFilterAndSort(wrapper) {
    const state = /** @type {any} */ (wrapper)._tableState;
    if (!state || !state.tbody) return;
    const q = state.filterInput.value.trim().toLowerCase();
    const filtered = filterRows(state.data.rows, q);

    if (filtered.length === 0 && q) {
      state.tbody.innerHTML = `<tr><td class="monitoring-table-no-matches" colspan="${state.data.columnLabels.length}">${win.__escapeHtml(L.statusNoMatchingRows)}</td></tr>`;
    } else {
      renderRows(state.tbody, filtered, state.sortCol, state.sortAsc);
    }
    state.matchCount.textContent = q
      ? L.statusFilteredRows(filtered.length, state.data.rows.length)
      : '';
  }

  /**
   * @param {HTMLElement} wrapper
   * @param {any} data
   */
  function renderTableInEl(wrapper, data) {
    const w = /** @type {any} */ (wrapper);
    let toolbar = /** @type {HTMLElement | null} */ (
      wrapper.querySelector(':scope > .monitoring-table-toolbar')
    );
    let scrollEl = /** @type {HTMLElement | null} */ (
      wrapper.querySelector(':scope > .monitoring-table-scroll')
    );
    let filterInput = /** @type {HTMLInputElement | null} */ (
      toolbar ? toolbar.querySelector('.monitoring-table-filter') : null
    );
    let matchCount = /** @type {HTMLElement | null} */ (
      toolbar ? toolbar.querySelector('.monitoring-table-match-count') : null
    );

    if (!toolbar || !scrollEl || !filterInput || !matchCount) {
      wrapper.innerHTML = '';
      toolbar = document.createElement('div');
      toolbar.className = 'monitoring-table-toolbar';
      filterInput = document.createElement('input');
      filterInput.type = 'text';
      filterInput.className = 'monitoring-table-filter';
      filterInput.placeholder = L.placeholderTableFilter;
      matchCount = document.createElement('span');
      matchCount.className = 'monitoring-table-match-count';
      toolbar.appendChild(filterInput);
      toolbar.appendChild(matchCount);
      scrollEl = document.createElement('div');
      scrollEl.className = 'monitoring-table-scroll';
      wrapper.appendChild(toolbar);
      wrapper.appendChild(scrollEl);

      filterInput.addEventListener('input', () => applyFilterAndSort(wrapper));

      scrollEl.addEventListener('click', (event) => {
        const target = /** @type {HTMLElement} */ (event.target);
        if (target.tagName === 'A' && target.classList.contains('monitoring-record-link')) {
          event.preventDefault();
          const recordId = target.getAttribute('data-record-id');
          if (recordId) {
            vscode.postMessage({ type: 'openRecord', recordId });
          }
        }
      });
    }

    if (!data.rows || data.rows.length === 0) {
      scrollEl.innerHTML = '';
      const empty = document.createElement('span');
      empty.className = 'monitoring-table-no-matches';
      empty.textContent = L.statusNoData;
      scrollEl.appendChild(empty);
      filterInput.disabled = true;
      matchCount.textContent = '';
      w._tableState = { data, sortCol: -1, sortAsc: true };
      return;
    }
    filterInput.disabled = false;

    scrollEl.innerHTML = '';
    const table = document.createElement('table');
    table.className = 'monitoring-table';
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    data.columnLabels.forEach((/** @type {string} */ lbl, /** @type {number} */ i) => {
      const th = document.createElement('th');
      th.className = 'monitoring-table-th';
      th.textContent = lbl;
      th.addEventListener('click', () => {
        const state = w._tableState;
        if (!state) return;
        if (state.sortCol === i) {
          state.sortAsc = !state.sortAsc;
        } else {
          state.sortCol = i;
          state.sortAsc = true;
        }
        applyFilterAndSort(wrapper);
      });
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    table.appendChild(tbody);
    scrollEl.appendChild(table);

    const prev = w._tableState;
    const keepSort = !!(
      prev &&
      prev.data &&
      prev.data.columnLabels &&
      prev.data.columnLabels.length === data.columnLabels.length
    );
    w._tableState = {
      data,
      tbody,
      sortCol: keepSort ? prev.sortCol : -1,
      sortAsc: keepSort ? prev.sortAsc : true,
      matchCount,
      filterInput,
    };

    applyFilterAndSort(wrapper);
  }

  /**
   * @param {string} configId
   * @param {any} data
   */
  function renderTable(configId, data) {
    const card = grid.querySelector('[data-config-id="' + configId + '"]');
    if (!card) return;
    const wrapper = /** @type {HTMLElement | null} */ (
      card.querySelector('.monitoring-table-wrapper')
    );
    if (!wrapper) return;
    renderTableInEl(wrapper, data);
    setCardStatus(configId, L.statusRows(data.totalRows));
  }

  return { renderTable, renderTableInEl };
}

// @ts-check
// SOQL Quick Query editor on the Overview tab:
//   - textarea + Run/Clear buttons + keyboard shortcut (Cmd/Ctrl+Enter)
//   - renders the results table or an error box
// Also exposes win.__clearQueryResults for org-lifecycle.js to call on disconnect.

(function () {
  const win = /** @type {any} */ (window);
  const vscode = win.__vscode;

  const soqlInput = /** @type {HTMLTextAreaElement} */ (document.getElementById('soql-input'));
  const btnRunQuery = /** @type {HTMLButtonElement} */ (document.getElementById('btn-run-query'));
  const btnClearQuery = /** @type {HTMLButtonElement} */ (
    document.getElementById('btn-clear-query')
  );
  const queryHint = /** @type {HTMLElement} */ (document.getElementById('query-hint'));
  const queryResults = /** @type {HTMLElement} */ (document.getElementById('query-results'));
  const resultsMeta = /** @type {HTMLElement} */ (document.getElementById('results-meta'));
  const resultsThead = /** @type {HTMLElement} */ (document.getElementById('results-thead'));
  const resultsTbody = /** @type {HTMLElement} */ (document.getElementById('results-tbody'));
  const queryError = /** @type {HTMLElement} */ (document.getElementById('query-error'));

  function clearResults() {
    queryResults.style.display = 'none';
    queryError.style.display = 'none';
    resultsThead.innerHTML = '';
    resultsTbody.innerHTML = '';
    resultsMeta.textContent = '';
  }

  // Expose for org-lifecycle.js to clear on disconnect.
  win.__clearQueryResults = clearResults;

  /** @param {any} str */
  function escapeCell(str) {
    if (str == null) return '<em style="opacity:0.5">null</em>';
    return win.__escapeHtml(str);
  }

  /** @param {{ records: any[], totalSize: number }} data */
  function renderQueryResults(data) {
    clearResults();
    queryError.style.display = 'none';

    const { records, totalSize } = data;
    if (!records || records.length === 0) {
      resultsMeta.textContent = 'Query returned 0 records.';
      queryResults.style.display = '';
      return;
    }

    resultsMeta.textContent = `${totalSize} record${totalSize !== 1 ? 's' : ''} (showing ${records.length})`;

    const cols = Object.keys(records[0]).filter((k) => k !== 'attributes');

    const tr = document.createElement('tr');
    for (const col of cols) {
      const th = document.createElement('th');
      th.textContent = col;
      tr.appendChild(th);
    }
    resultsThead.appendChild(tr);

    for (const record of records) {
      const row = document.createElement('tr');
      for (const col of cols) {
        const td = document.createElement('td');
        const val = record[col];
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          td.innerHTML = `<code>${escapeCell(JSON.stringify(val))}</code>`;
        } else {
          td.innerHTML = escapeCell(val);
        }
        row.appendChild(td);
      }
      resultsTbody.appendChild(row);
    }

    queryResults.style.display = '';
  }

  // ── Message handlers ────────────────────────────────────────────────────
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

  // ── Button handlers ─────────────────────────────────────────────────────
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

  soqlInput.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      btnRunQuery.click();
    }
  });
})();

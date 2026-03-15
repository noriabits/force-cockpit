// @ts-check
// Reactivate OmniScript — feature webview script
// Runs inside the VSCode webview. Uses window.__vscode (set by main.js) for postMessage.
// Registers with the feature message bus via window.__registerFeature().
// All user-facing strings are sourced from window.ReactivateOmniscriptLabels (set by labels.js).

(function () {
  const win = /** @type {any} */ (window);
  const L = win.ReactivateOmniscriptLabels;

  // ── DOM refs ──────────────────────────────────────────────────────────────
  const roDescription = /** @type {HTMLElement} */ (document.getElementById('ro-description'));
  const btnFetch = /** @type {HTMLButtonElement} */ (document.getElementById('btn-ro-fetch'));
  const fetchStatus = /** @type {HTMLElement} */ (document.getElementById('ro-fetch-status'));
  const filtersDiv = /** @type {HTMLElement} */ (document.getElementById('ro-filters'));
  const filterType = /** @type {HTMLInputElement} */ (document.getElementById('ro-filter-type'));
  const filterSubtype = /** @type {HTMLInputElement} */ (
    document.getElementById('ro-filter-subtype')
  );
  const resultsDiv = /** @type {HTMLElement} */ (document.getElementById('ro-results'));
  const tbody = /** @type {HTMLElement} */ (document.getElementById('ro-tbody'));
  const selectedDiv = /** @type {HTMLElement} */ (document.getElementById('ro-selected'));
  const selectedLabel = /** @type {HTMLElement} */ (document.getElementById('ro-selected-label'));
  const btnClear = /** @type {HTMLButtonElement} */ (document.getElementById('btn-ro-clear'));
  const fetchError = /** @type {HTMLElement} */ (document.getElementById('ro-fetch-error'));
  const btnReactivate = /** @type {HTMLButtonElement} */ (
    document.getElementById('btn-ro-reactivate')
  );
  const roStatus = /** @type {HTMLElement} */ (document.getElementById('ro-status'));
  const roResult = /** @type {HTMLElement} */ (document.getElementById('ro-result'));
  const roError = /** @type {HTMLElement} */ (document.getElementById('ro-error'));

  // Apply labels
  roDescription.textContent = L.descFeature;
  btnFetch.textContent = L.btnFetch;
  btnReactivate.textContent = L.btnReactivate;
  btnClear.textContent = L.btnChange;
  filterType.placeholder = L.placeholderFilterType;
  filterSubtype.placeholder = L.placeholderFilterSubtype;

  // ── State ─────────────────────────────────────────────────────────────────
  let connected = false;
  /** @type {Array<{ Id: string, Type: string, SubType: string, Language: string }>} */
  let allRecords = [];
  /** @type {string | null} */
  let selectedId = null;

  // ── Helpers ───────────────────────────────────────────────────────────────
  /** @param {unknown} str @returns {string} */
  function escapeHtml(str) {
    return win.__escapeHtml(str);
  }

  function renderTable() {
    const typeFilter = filterType.value.trim().toLowerCase();
    const subtypeFilter = filterSubtype.value.trim().toLowerCase();

    const filtered = allRecords.filter(function (r) {
      const matchType = !typeFilter || r.Type.toLowerCase().indexOf(typeFilter) !== -1;
      const matchSubtype = !subtypeFilter || r.SubType.toLowerCase().indexOf(subtypeFilter) !== -1;
      return matchType && matchSubtype;
    });

    tbody.innerHTML = '';
    for (let i = 0; i < filtered.length; i++) {
      const r = filtered[i];
      const row = document.createElement('tr');
      row.innerHTML =
        '<td>' +
        escapeHtml(r.Type) +
        '</td>' +
        '<td>' +
        escapeHtml(r.SubType) +
        '</td>' +
        '<td>' +
        escapeHtml(r.Language) +
        '</td>' +
        '<td></td>';
      const selectBtn = document.createElement('button');
      selectBtn.className = 'btn btn-ghost btn-select';
      selectBtn.textContent = L.btnSelect;
      selectBtn.setAttribute('data-id', r.Id);
      selectBtn.setAttribute('data-type', r.Type);
      selectBtn.setAttribute('data-subtype', r.SubType);
      selectBtn.setAttribute('data-language', r.Language);
      selectBtn.addEventListener('click', onSelectClick);
      const lastCell = /** @type {HTMLElement} */ (row.lastElementChild);
      lastCell.appendChild(selectBtn);
      tbody.appendChild(row);
    }
    resultsDiv.style.display = filtered.length > 0 ? '' : 'none';
  }

  /** @param {Event} e */
  function onSelectClick(e) {
    const btn = /** @type {HTMLElement} */ (e.currentTarget);
    selectedId = btn.getAttribute('data-id');
    const type = btn.getAttribute('data-type') || '';
    const subtype = btn.getAttribute('data-subtype') || '';
    const language = btn.getAttribute('data-language') || '';
    selectedLabel.textContent = type + ' / ' + subtype + ' (' + language + ')';
    selectedDiv.style.display = '';
    resultsDiv.style.display = 'none';
    filtersDiv.style.display = 'none';
    btnReactivate.disabled = false;
  }

  function clearSelection() {
    selectedId = null;
    selectedDiv.style.display = 'none';
    btnReactivate.disabled = true;
    if (allRecords.length > 0) {
      filtersDiv.style.display = '';
      renderTable();
    }
  }

  // ── Event listeners ───────────────────────────────────────────────────────
  btnFetch.addEventListener('click', function () {
    if (!connected) {
      fetchError.textContent = L.errorNotConnected;
      fetchError.style.display = '';
      return;
    }
    btnFetch.disabled = true;
    fetchStatus.textContent = L.statusFetching;
    fetchError.style.display = 'none';
    resultsDiv.style.display = 'none';
    filtersDiv.style.display = 'none';
    selectedDiv.style.display = 'none';
    roResult.style.display = 'none';
    roError.style.display = 'none';
    allRecords = [];
    selectedId = null;
    btnReactivate.disabled = true;
    win.__vscode.postMessage({ type: 'reactivateOmniscriptFetch' });
  });

  filterType.addEventListener('input', renderTable);
  filterSubtype.addEventListener('input', renderTable);

  btnClear.addEventListener('click', clearSelection);

  /** @type {string | null} */
  let _reactivateOpId = null;

  btnReactivate.addEventListener('click', function () {
    if (!connected || !selectedId) return;
    roStatus.textContent = L.statusReactivating;
    roResult.style.display = 'none';
    roError.style.display = 'none';
    _reactivateOpId = win.__startAction(btnReactivate, function () {
      roStatus.textContent = '';
    });
    win.__vscode.postMessage({
      type: 'reactivateOmniscript',
      omniscriptId: selectedId,
      opId: _reactivateOpId,
    });
  });

  // ── Feature registration ──────────────────────────────────────────────────
  win.__registerFeature('reactivate-omniscript', {
    onOrgConnected: function () {
      connected = true;
      btnFetch.disabled = false;
    },
    onOrgDisconnected: function () {
      connected = false;
      btnFetch.disabled = true;
      btnReactivate.disabled = true;
      fetchStatus.textContent = '';
      roStatus.textContent = '';
      allRecords = [];
      selectedId = null;
      resultsDiv.style.display = 'none';
      filtersDiv.style.display = 'none';
      selectedDiv.style.display = 'none';
      roResult.style.display = 'none';
      roError.style.display = 'none';
      fetchError.style.display = 'none';
    },
    /** @param {{ type: string, data: any }} message */
    onMessage: function (message) {
      switch (message.type) {
        case 'reactivateOmniscriptFetchResult': {
          btnFetch.disabled = false;
          fetchStatus.textContent = '';
          const records = message.data.records || [];
          allRecords = records;
          if (records.length === 0) {
            fetchError.textContent = L.errorNoResults;
            fetchError.style.display = '';
            resultsDiv.style.display = 'none';
            filtersDiv.style.display = 'none';
            return;
          }
          filterType.value = '';
          filterSubtype.value = '';
          filtersDiv.style.display = '';
          renderTable();
          break;
        }
        case 'reactivateOmniscriptFetchError':
          btnFetch.disabled = false;
          fetchStatus.textContent = '';
          fetchError.textContent = message.data.message;
          fetchError.style.display = '';
          resultsDiv.style.display = 'none';
          filtersDiv.style.display = 'none';
          break;

        case 'reactivateOmniscriptResult':
          win.__endAction(_reactivateOpId);
          _reactivateOpId = null;
          roStatus.textContent = '';
          roError.style.display = 'none';
          roResult.textContent = message.data.message;
          roResult.style.display = '';
          break;

        case 'reactivateOmniscriptError':
          win.__endAction(_reactivateOpId);
          _reactivateOpId = null;
          roStatus.textContent = '';
          roResult.style.display = 'none';
          roError.textContent = message.data.message;
          roError.style.display = '';
          break;
      }
    },
  });
})();

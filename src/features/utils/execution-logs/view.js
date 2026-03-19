// @ts-check
(function () {
  const win = /** @type {any} */ (window);
  const vscode = win.__vscode;

  const searchInput = /** @type {HTMLInputElement} */ (document.getElementById('logs-search'));
  const logsList = /** @type {HTMLElement} */ (document.getElementById('logs-list'));
  const logsEmpty = /** @type {HTMLElement} */ (document.getElementById('logs-empty'));
  const selectAllLabel = /** @type {HTMLElement} */ (
    document.getElementById('logs-select-all-label')
  );
  const selectAllChk = /** @type {HTMLInputElement} */ (document.getElementById('logs-select-all'));
  const deleteBtn = /** @type {HTMLButtonElement} */ (document.getElementById('logs-delete-btn'));

  /** @type {{ filename: string, createdAt: number }[]} */
  let allLogs = [];

  /** @type {Set<string>} */
  let selectedFilenames = new Set();

  function loadLogs() {
    vscode.postMessage({ type: 'loadExecutionLogs' });
  }

  /**
   * @param {number} ms
   * @returns {string}
   */
  function formatDate(ms) {
    const d = new Date(ms);
    const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
    return (
      `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    );
  }

  function updateToolbarVisibility() {
    const hasLogs = allLogs.length > 0;
    selectAllLabel.style.display = hasLogs ? '' : 'none';
    deleteBtn.style.display = hasLogs ? '' : 'none';

    const checkedCount = selectedFilenames.size;
    if (checkedCount === 0) {
      selectAllChk.checked = false;
      selectAllChk.indeterminate = false;
    } else if (checkedCount === allLogs.length) {
      selectAllChk.checked = true;
      selectAllChk.indeterminate = false;
    } else {
      selectAllChk.checked = false;
      selectAllChk.indeterminate = true;
    }

    deleteBtn.textContent = checkedCount > 0 ? `Delete (${checkedCount})` : 'Delete';
    deleteBtn.disabled = checkedCount === 0;
  }

  /**
   * @param {string} query
   */
  function renderList(query) {
    const q = query.toLowerCase();
    const filtered = q ? allLogs.filter((l) => l.filename.toLowerCase().includes(q)) : allLogs;

    logsList.innerHTML = '';
    if (filtered.length === 0) {
      logsEmpty.style.display = '';
      updateToolbarVisibility();
      return;
    }
    logsEmpty.style.display = 'none';

    for (const log of filtered) {
      const item = document.createElement('div');
      item.className = 'logs-item';
      item.dataset.filename = log.filename;

      const chk = /** @type {HTMLInputElement} */ (document.createElement('input'));
      chk.type = 'checkbox';
      chk.className = 'logs-item-checkbox';
      chk.checked = selectedFilenames.has(log.filename);
      chk.addEventListener('change', () => {
        if (chk.checked) {
          selectedFilenames.add(log.filename);
        } else {
          selectedFilenames.delete(log.filename);
        }
        updateToolbarVisibility();
      });
      chk.addEventListener('click', (e) => e.stopPropagation());

      const nameEl = document.createElement('span');
      nameEl.className = 'logs-item-name';
      nameEl.textContent = log.filename.replace(/\.log$/, '');

      const dateEl = document.createElement('span');
      dateEl.className = 'logs-item-date';
      dateEl.textContent = formatDate(log.createdAt);

      item.appendChild(chk);
      item.appendChild(nameEl);
      item.appendChild(dateEl);

      item.addEventListener('click', () => {
        vscode.postMessage({ type: 'openExecutionLog', filename: log.filename });
      });

      logsList.appendChild(item);
    }

    updateToolbarVisibility();
  }

  selectAllChk.addEventListener('change', () => {
    if (selectAllChk.checked) {
      for (const log of allLogs) selectedFilenames.add(log.filename);
    } else {
      selectedFilenames.clear();
    }
    renderList(searchInput.value);
  });

  deleteBtn.addEventListener('click', () => {
    if (selectedFilenames.size === 0) return;
    vscode.postMessage({ type: 'deleteExecutionLogs', filenames: Array.from(selectedFilenames) });
  });

  searchInput.addEventListener('input', () => {
    renderList(searchInput.value);
  });

  win.__registerFeature('execution-logs', {
    onMessage: function (/** @type {{ type: string, data: any }} */ message) {
      switch (message.type) {
        case 'loadExecutionLogsResult': {
          allLogs = message.data.logs || [];
          const existingNames = new Set(allLogs.map((l) => l.filename));
          for (const f of selectedFilenames) {
            if (!existingNames.has(f)) selectedFilenames.delete(f);
          }
          renderList(searchInput.value);
          break;
        }
        case 'executionLogsChanged': {
          loadLogs();
          break;
        }
        case 'deleteExecutionLogsResult': {
          // Reload triggered automatically by the file-system watcher.
          break;
        }
        case 'deleteExecutionLogsError': {
          console.error('Failed to delete logs:', message.data);
          break;
        }
      }
    },
  });

  loadLogs();
})();

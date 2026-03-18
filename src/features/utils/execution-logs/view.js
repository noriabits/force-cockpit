// @ts-check
(function () {
  const win = /** @type {any} */ (window);
  const vscode = win.__vscode;

  const searchInput = /** @type {HTMLInputElement} */ (document.getElementById('logs-search'));
  const logsList = /** @type {HTMLElement} */ (document.getElementById('logs-list'));
  const logsEmpty = /** @type {HTMLElement} */ (document.getElementById('logs-empty'));

  /** @type {{ filename: string, createdAt: number }[]} */
  let allLogs = [];

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

  /**
   * @param {string} query
   */
  function renderList(query) {
    const q = query.toLowerCase();
    const filtered = q ? allLogs.filter((l) => l.filename.toLowerCase().includes(q)) : allLogs;

    logsList.innerHTML = '';
    if (filtered.length === 0) {
      logsEmpty.style.display = '';
      return;
    }
    logsEmpty.style.display = 'none';

    for (const log of filtered) {
      const item = document.createElement('div');
      item.className = 'logs-item';
      item.dataset.filename = log.filename;

      const nameEl = document.createElement('span');
      nameEl.className = 'logs-item-name';
      nameEl.textContent = log.filename.replace(/\.log$/, '');

      const dateEl = document.createElement('span');
      dateEl.className = 'logs-item-date';
      dateEl.textContent = formatDate(log.createdAt);

      item.appendChild(nameEl);
      item.appendChild(dateEl);

      item.addEventListener('click', () => {
        vscode.postMessage({ type: 'openExecutionLog', filename: log.filename });
      });

      logsList.appendChild(item);
    }
  }

  searchInput.addEventListener('input', () => {
    renderList(searchInput.value);
  });

  win.__registerFeature('execution-logs', {
    onMessage: function (/** @type {{ type: string, data: any }} */ message) {
      switch (message.type) {
        case 'loadExecutionLogsResult': {
          allLogs = message.data.logs || [];
          renderList(searchInput.value);
          break;
        }
        case 'executionLogsChanged': {
          loadLogs();
          break;
        }
      }
    },
  });

  loadLogs();
})();

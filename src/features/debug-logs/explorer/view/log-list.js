// @ts-check
// The log list: sortable table, text/errors-only filtering, the "hide empty
// logs" noise filter, selection + delete, and the live tail poll.
import { sortRows } from '../../../shared/view/table-sort';
import { formatBytes, formatClock, formatMs, shortStatus } from './format';

/** How often the live tail asks the org for new logs. */
const TAIL_INTERVAL_MS = 8000;

/**
 * @param {{
 *   labels: any,
 *   vscode: { postMessage: (msg: any) => void },
 *   escapeHtml: (s: string) => string,
 *   getConnected: () => boolean,
 *   getVisible: () => boolean,
 *   onOpenLog: (logId: string) => void,
 *   onStateChange: (patch: any) => void,
 * }} ctx
 */
export function createLogList(ctx) {
  const { labels, vscode, escapeHtml } = ctx;
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

  const filterInput = /** @type {HTMLInputElement} */ ($('dbg-log-filter'));
  const countEl = $('dbg-log-count');
  const errorsOnly = /** @type {HTMLInputElement} */ ($('dbg-errors-only'));
  const hideEmpty = /** @type {HTMLInputElement} */ ($('dbg-hide-empty'));
  const liveTail = /** @type {HTMLInputElement} */ ($('dbg-live-tail'));
  const refreshBtn = /** @type {HTMLButtonElement} */ ($('dbg-refresh-logs'));
  const deleteBtn = /** @type {HTMLButtonElement} */ ($('dbg-delete-selected'));
  const deleteAllBtn = /** @type {HTMLButtonElement} */ ($('dbg-delete-all'));
  const hiddenChip = $('dbg-hidden-chip');
  const thead = $('dbg-log-thead');
  const tbody = $('dbg-log-tbody');
  const emptyEl = $('dbg-list-empty');
  const statusEl = $('dbg-list-status');
  const errorEl = $('dbg-list-error');

  /** @type {any[]} */ let logs = [];
  /** @type {Set<string>} */ const selected = new Set();
  /** @type {Map<string, boolean>} */ const emptyByContent = new Map();
  /** @type {Set<string>} */ let knownIds = new Set();
  let sortCol = 0;
  let sortAsc = false;
  let showHiddenAnyway = false;
  let hiddenCount = 0;
  let openLogId = '';
  /** @type {any} */ let tailTimer = null;
  let firstLoad = true;

  const COLUMNS = labels.columns;

  // ── Filtering ───────────────────────────────────────────────────────────

  function isFailure(/** @type {any} */ log) {
    return !!log.status && log.status !== 'Success';
  }

  /**
   * True when the row should be hidden by the noise filter. The operation-name
   * pre-filter (`emptyByMetadata`) is only a guess for orgs that route real
   * business logic through Aura/Lightning-invoked Apex (OmniStudio, CPQ,
   * LWC-invoked controllers) — it is used as a provisional verdict until the
   * body has been checked, then the content result always wins. A failed
   * transaction is never hidden.
   */
  function isEmpty(/** @type {any} */ log) {
    if (!hideEmpty.checked) return false;
    if (isFailure(log)) return false;
    const byContent = emptyByContent.get(log.id);
    if (byContent !== undefined) return byContent;
    return !!log.emptyByMetadata;
  }

  function matchesText(/** @type {any} */ log) {
    const query = filterInput.value.trim().toLowerCase();
    if (!query) return true;
    return [log.logUserName, log.operation, log.status, log.application, log.request]
      .join(' ')
      .toLowerCase()
      .includes(query);
  }

  function visibleLogs() {
    hiddenCount = 0;
    const rows = [];
    for (const log of logs) {
      if (errorsOnly.checked && !isFailure(log)) continue;
      if (!matchesText(log)) continue;
      if (isEmpty(log)) {
        hiddenCount++;
        if (!showHiddenAnyway) continue;
      }
      rows.push(log);
    }
    return rows;
  }

  // ── Rendering ───────────────────────────────────────────────────────────

  function renderHead() {
    thead.innerHTML = '';
    const row = document.createElement('tr');
    const selectAll = document.createElement('th');
    selectAll.className = 'dbg-col-check';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.addEventListener('change', () => {
      const rows = visibleLogs();
      if (box.checked) rows.forEach((log) => selected.add(log.id));
      else rows.forEach((log) => selected.delete(log.id));
      render();
    });
    selectAll.appendChild(box);
    row.appendChild(selectAll);

    COLUMNS.forEach((/** @type {string} */ name, /** @type {number} */ index) => {
      const th = document.createElement('th');
      th.textContent = name + (sortCol === index ? (sortAsc ? ' ▲' : ' ▼') : '');
      th.addEventListener('click', () => {
        if (sortCol === index) sortAsc = !sortAsc;
        else {
          sortCol = index;
          sortAsc = true;
        }
        render();
      });
      row.appendChild(th);
    });
    thead.appendChild(row);
  }

  /** Table cells for one log, in COLUMNS order. */
  function cellsOf(/** @type {any} */ log) {
    return [
      formatClock(log.startTime),
      log.logUserName,
      log.operation,
      shortStatus(log.status),
      formatMs(log.durationMilliseconds),
      formatBytes(log.logLength),
      log.request,
    ];
  }

  function render() {
    const rows = visibleLogs();
    // Sort on the raw values (not the formatted cells) so time, duration and
    // size order numerically. sortRows returns the same row references, so a
    // Map takes us straight back to the log each row came from.
    const logByRow = new Map();
    const sortableRows = rows.map((log) => {
      const row = [
        log.startTime,
        log.logUserName,
        log.operation,
        log.status,
        String(log.durationMilliseconds),
        String(log.logLength),
        log.request,
      ];
      logByRow.set(row, log);
      return row;
    });
    const sorted = sortRows(sortableRows, sortCol, sortAsc).map((row) => logByRow.get(row));

    renderHead();
    tbody.innerHTML = '';
    for (const log of /** @type {any[]} */ (sorted)) {
      const tr = document.createElement('tr');
      tr.className = 'dbg-log-row';
      if (isFailure(log)) tr.classList.add('dbg-log-row--error');
      if (log.id === openLogId) tr.classList.add('dbg-log-row--open');
      if (isEmpty(log)) tr.classList.add('dbg-log-row--empty');

      const checkCell = document.createElement('td');
      checkCell.className = 'dbg-col-check';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = selected.has(log.id);
      box.addEventListener('click', (e) => e.stopPropagation());
      box.addEventListener('change', () => {
        if (box.checked) selected.add(log.id);
        else selected.delete(log.id);
        updateDeleteButton();
      });
      checkCell.appendChild(box);
      tr.appendChild(checkCell);

      for (const value of cellsOf(log)) {
        const td = document.createElement('td');
        td.textContent = value ?? '';
        tr.appendChild(td);
      }
      tr.addEventListener('click', () => {
        openLogId = log.id;
        ctx.onOpenLog(log.id);
        render();
      });
      tbody.appendChild(tr);
    }

    countEl.textContent = logs.length ? `${sorted.length} of ${logs.length}` : '';
    emptyEl.style.display = logs.length === 0 ? '' : 'none';
    emptyEl.textContent = ctx.getConnected() ? labels.noLogs : labels.notConnected;
    renderHiddenChip();
    updateDeleteButton();
  }

  function renderHiddenChip() {
    if (!hiddenCount || showHiddenAnyway) {
      hiddenChip.style.display = 'none';
      hiddenChip.innerHTML = '';
      return;
    }
    hiddenChip.style.display = '';
    hiddenChip.innerHTML = `<span>${escapeHtml(labels.hiddenAsEmpty(hiddenCount))}</span>`;
    const show = document.createElement('button');
    show.type = 'button';
    show.className = 'btn btn-ghost';
    show.textContent = labels.show;
    show.addEventListener('click', () => {
      showHiddenAnyway = true;
      render();
    });
    hiddenChip.appendChild(show);
  }

  function updateDeleteButton() {
    // Only count selections that are still in the list.
    for (const id of [...selected]) {
      if (!logs.some((log) => log.id === id)) selected.delete(id);
    }
    deleteBtn.textContent = labels.deleteSelected(selected.size);
    deleteBtn.disabled = selected.size === 0;
  }

  // ── Content-aware noise check ───────────────────────────────────────────

  /**
   * Ask the host to inspect the bodies of every candidate row — the content is
   * what actually decides "empty" (see `isEmpty`); the operation-name
   * pre-filter is only a provisional guess and must not skip this check, or a
   * false-positive pattern match (e.g. a real Lightning-invoked Apex
   * controller) would stay hidden forever. Capped per pass and cached
   * host-side, so the fetches stay bounded.
   */
  function requestContentCheck() {
    if (!hideEmpty.checked) return;
    const pending = logs
      .filter((log) => !isFailure(log) && !emptyByContent.has(log.id))
      .slice(0, 40)
      .map((log) => log.id);
    if (!pending.length) return;
    statusEl.textContent = labels.checkingContents;
    vscode.postMessage({ type: 'classifyApexLogs', logIds: pending });
  }

  // ── Live tail ───────────────────────────────────────────────────────────

  function syncTail() {
    if (tailTimer) {
      clearInterval(tailTimer);
      tailTimer = null;
    }
    if (!liveTail.checked) return;
    tailTimer = setInterval(() => {
      // Only poll when it can be seen: connected, panel visible, tab open.
      if (!ctx.getConnected() || !ctx.getVisible()) return;
      if (!document.getElementById('tab-debug-logs')?.classList.contains('active')) return;
      vscode.postMessage({ type: 'loadApexLogs' });
    }, TAIL_INTERVAL_MS);
  }

  /** Warn (once per log) when a tailed transaction comes back failed. */
  function notifyNewFailures(/** @type {any[]} */ incoming) {
    if (firstLoad) {
      firstLoad = false;
      knownIds = new Set(incoming.map((log) => log.id));
      return;
    }
    for (const log of incoming) {
      if (knownIds.has(log.id)) continue;
      if (liveTail.checked && isFailure(log)) {
        vscode.postMessage({
          type: 'notifyApexLogFailure',
          operation: log.operation,
          status: log.status,
        });
      }
    }
    knownIds = new Set(incoming.map((log) => log.id));
  }

  // ── Wiring ──────────────────────────────────────────────────────────────

  filterInput.addEventListener('input', render);
  errorsOnly.addEventListener('change', () => {
    ctx.onStateChange({ errorsOnly: errorsOnly.checked });
    render();
  });
  hideEmpty.addEventListener('change', () => {
    showHiddenAnyway = false;
    ctx.onStateChange({ hideEmptyLogs: hideEmpty.checked });
    requestContentCheck();
    render();
  });
  liveTail.addEventListener('change', () => {
    ctx.onStateChange({ liveTail: liveTail.checked });
    syncTail();
  });
  refreshBtn.addEventListener('click', () => vscode.postMessage({ type: 'loadApexLogs' }));
  deleteBtn.addEventListener('click', () => {
    if (selected.size === 0) return;
    vscode.postMessage({ type: 'deleteApexLogs', logIds: [...selected] });
  });
  deleteAllBtn.addEventListener('click', () => {
    if (!logs.length) return;
    vscode.postMessage({ type: 'deleteApexLogs', logIds: logs.map((log) => log.id) });
  });

  return {
    applyState(/** @type {any} */ state) {
      errorsOnly.checked = !!state.errorsOnly;
      hideEmpty.checked = !!state.hideEmptyLogs;
      liveTail.checked = !!state.liveTail;
      syncTail();
      // The list may already have rendered before the stored state arrived.
      requestContentCheck();
      render();
    },
    setLogs(/** @type {any[]} */ incoming) {
      notifyNewFailures(incoming);
      logs = incoming;
      errorEl.style.display = 'none';
      statusEl.textContent = '';
      requestContentCheck();
      render();
    },
    setClassification(/** @type {{id: string, empty: boolean}[]} */ results) {
      for (const result of results) emptyByContent.set(result.id, result.empty);
      statusEl.textContent = '';
      render();
    },
    showError(/** @type {string} */ message) {
      statusEl.textContent = '';
      errorEl.textContent = message;
      errorEl.style.display = '';
    },
    clearSelection() {
      selected.clear();
      updateDeleteButton();
    },
    setOpenLog(/** @type {string} */ logId) {
      openLogId = logId;
      render();
    },
    reset() {
      logs = [];
      selected.clear();
      emptyByContent.clear();
      knownIds = new Set();
      firstLoad = true;
      openLogId = '';
      render();
    },
    stopTail() {
      if (tailTimer) {
        clearInterval(tailTimer);
        tailTimer = null;
      }
    },
    resumeTail: syncTail,
  };
}

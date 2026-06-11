// @ts-check
// Query history dropdown for the Overview Quick Query: a "History ▾" button that
// opens a panel with two sections — Saved (named, removable) and Recent
// (auto-recorded). Persistence lives host-side (QueryStateStore); this module
// posts addQueryHistory / saveSavedQueries and re-renders on the host's replies.

/**
 * @typedef {{ query: string, useToolingApi: boolean }} HistoryEntry
 * @typedef {{ name: string, query: string, useToolingApi: boolean }} SavedQuery
 */

/**
 * @typedef {Object} QueryHistoryCtx
 * @property {HTMLButtonElement} buttonEl     "History ▾" toggle.
 * @property {HTMLElement} dropdownEl         Container for the panel.
 * @property {HTMLButtonElement} saveBtn      "★ Save" current query.
 * @property {{ postMessage: (msg: any) => void }} vscode
 * @property {() => { query: string, useToolingApi: boolean }} getCurrent
 * @property {(entry: { query: string, useToolingApi: boolean }) => void} onPick
 */

/** @param {QueryHistoryCtx} ctx */
export function createQueryHistory(ctx) {
  const { buttonEl, dropdownEl, saveBtn, vscode, getCurrent, onPick } = ctx;

  /** @type {HistoryEntry[]} */
  let history = [];
  /** @type {SavedQuery[]} */
  let saved = [];
  let open = false;
  let showSaveRow = false;

  function close() {
    open = false;
    showSaveRow = false;
    dropdownEl.style.display = 'none';
  }

  function toggle() {
    open = !open;
    if (open) render();
    else close();
  }

  /** @param {string} q */
  function truncate(q) {
    const oneLine = q.replace(/\s+/g, ' ').trim();
    return oneLine.length > 70 ? oneLine.slice(0, 70) + '…' : oneLine;
  }

  function render() {
    dropdownEl.innerHTML = '';
    dropdownEl.style.display = '';

    if (showSaveRow) dropdownEl.appendChild(buildSaveRow());

    dropdownEl.appendChild(buildSection('Saved', saved, true));
    dropdownEl.appendChild(buildSection('Recent', history, false));
  }

  function buildSaveRow() {
    const row = document.createElement('div');
    row.className = 'query-history-save-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'query-history-save-input';
    input.placeholder = 'Name this query…';
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'btn btn-ghost';
    confirm.textContent = 'Save';

    const commit = () => {
      const name = input.value.trim();
      if (!name) return;
      const cur = getCurrent();
      if (!cur.query.trim()) return;
      saved = [
        { name, query: cur.query, useToolingApi: cur.useToolingApi },
        ...saved.filter((s) => s.name !== name),
      ];
      vscode.postMessage({ type: 'saveSavedQueries', savedQueries: saved });
      showSaveRow = false;
      render();
    };
    confirm.addEventListener('click', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        showSaveRow = false;
        render();
      }
    });

    row.appendChild(input);
    row.appendChild(confirm);
    setTimeout(() => input.focus(), 0);
    return row;
  }

  /**
   * @param {string} title
   * @param {(HistoryEntry | SavedQuery)[]} items
   * @param {boolean} isSaved
   */
  function buildSection(title, items, isSaved) {
    const section = document.createElement('div');
    section.className = 'query-history-section';

    const header = document.createElement('div');
    header.className = 'query-history-section-title';
    header.textContent = `${title} (${items.length})`;
    section.appendChild(header);

    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'query-history-empty';
      empty.textContent = isSaved ? 'No saved queries.' : 'No recent queries.';
      section.appendChild(empty);
      return section;
    }

    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'query-history-item';

      const label = document.createElement('span');
      label.className = 'query-history-item-label';
      const safeItem = /** @type {SavedQuery} */ (item);
      label.textContent = isSaved ? safeItem.name : truncate(item.query);
      label.title = item.query;
      label.addEventListener('click', () => {
        onPick({ query: item.query, useToolingApi: item.useToolingApi });
        close();
      });
      row.appendChild(label);

      if (item.useToolingApi) {
        const badge = document.createElement('span');
        badge.className = 'query-history-tooling-badge';
        badge.textContent = 'Tooling';
        row.appendChild(badge);
      }

      if (isSaved) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'query-history-remove';
        remove.textContent = '×';
        remove.title = 'Remove saved query';
        remove.addEventListener('click', (e) => {
          e.stopPropagation();
          saved = saved.filter((s) => s !== item);
          vscode.postMessage({ type: 'saveSavedQueries', savedQueries: saved });
          render();
        });
        row.appendChild(remove);
      }

      section.appendChild(row);
    }
    return section;
  }

  // ── Wiring ──────────────────────────────────────────────────────────────────
  buttonEl.addEventListener('click', (e) => {
    e.stopPropagation();
    toggle();
  });
  saveBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    open = true;
    showSaveRow = true;
    render();
  });
  document.addEventListener('click', (e) => {
    if (open && !dropdownEl.contains(/** @type {Node} */ (e.target)) && e.target !== buttonEl) {
      close();
    }
  });

  // ── Public API ──────────────────────────────────────────────────────────────
  /** @param {{ history?: HistoryEntry[], savedQueries?: SavedQuery[] }} state */
  function load(state) {
    history = Array.isArray(state.history) ? state.history : [];
    saved = Array.isArray(state.savedQueries) ? state.savedQueries : [];
    if (open) render();
  }

  /** @param {string} query @param {boolean} useToolingApi */
  function recordRun(query, useToolingApi) {
    if (!query.trim()) return;
    vscode.postMessage({ type: 'addQueryHistory', query, useToolingApi });
  }

  /** @param {HistoryEntry[]} list */
  function onHistoryUpdated(list) {
    history = Array.isArray(list) ? list : [];
    if (open) render();
  }

  /** @param {SavedQuery[]} list */
  function onSavedUpdated(list) {
    saved = Array.isArray(list) ? list : [];
    if (open) render();
  }

  return { load, recordRun, onHistoryUpdated, onSavedUpdated };
}

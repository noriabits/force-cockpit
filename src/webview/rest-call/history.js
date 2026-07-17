// @ts-check
// Request history dropdown for the REST tab: a "History ▾" button that opens a
// panel with two sections — Saved (named, removable) and Recent (auto-recorded).
// Persistence lives host-side (RestCallStateStore); this module posts
// addRestCallHistory / saveRestCallSavedRequests and re-renders on the host's
// replies. Near-direct port of src/webview/query-editor/history.js, adapted to
// REST fields (method/endpoint/body/headers instead of query/useToolingApi).

/**
 * @typedef {{ key: string, value: string }} HeaderEntry
 * @typedef {{ method: string, endpoint: string, body: string, headers: HeaderEntry[] }} RestHistoryEntry
 * @typedef {{ name: string, method: string, endpoint: string, body: string, headers: HeaderEntry[] }} SavedRestCall
 */

/**
 * @typedef {Object} RestCallHistoryCtx
 * @property {HTMLButtonElement} buttonEl     "History ▾" toggle.
 * @property {HTMLElement} dropdownEl         Container for the panel.
 * @property {HTMLButtonElement} saveBtn      "★ Save" current request.
 * @property {{ postMessage: (msg: any) => void }} vscode
 * @property {() => { method: string, endpoint: string, body: string, headers: HeaderEntry[] }} getCurrent
 * @property {(entry: { method: string, endpoint: string, body: string, headers: HeaderEntry[] }) => void} onPick
 */

/** @param {RestCallHistoryCtx} ctx */
export function createRestCallHistory(ctx) {
  const { buttonEl, dropdownEl, saveBtn, vscode, getCurrent, onPick } = ctx;

  /** @type {RestHistoryEntry[]} */
  let history = [];
  /** @type {SavedRestCall[]} */
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

  /** The method is already shown in the badge, so the item text is just the endpoint. */
  /** @param {{ endpoint: string }} item */
  function itemText(item) {
    const oneLine = item.endpoint.replace(/\s+/g, ' ').trim();
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
    input.placeholder = 'Name this request…';
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'btn btn-ghost';
    confirm.textContent = 'Save';

    const commit = () => {
      const name = input.value.trim();
      if (!name) return;
      const cur = getCurrent();
      if (!cur.endpoint.trim()) return;
      saved = [
        {
          name,
          method: cur.method,
          endpoint: cur.endpoint,
          body: cur.body,
          headers: cur.headers,
        },
        ...saved.filter((s) => s.name !== name),
      ];
      vscode.postMessage({ type: 'saveRestCallSavedRequests', savedRequests: saved });
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
   * @param {(RestHistoryEntry | SavedRestCall)[]} items
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
      empty.textContent = isSaved ? 'No saved requests.' : 'No recent requests.';
      section.appendChild(empty);
      return section;
    }

    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'query-history-item';

      const methodBadge = document.createElement('span');
      methodBadge.className = 'query-history-tooling-badge';
      methodBadge.textContent = item.method;
      row.appendChild(methodBadge);

      const labelEl = document.createElement('span');
      labelEl.className = 'query-history-item-label';
      const safeItem = /** @type {SavedRestCall} */ (item);
      labelEl.textContent = isSaved ? safeItem.name : itemText(item);
      /** @type {any} */ (window).__setTooltip(labelEl, `${item.method} ${item.endpoint}`);
      labelEl.addEventListener('click', () => {
        onPick({
          method: item.method,
          endpoint: item.endpoint,
          body: item.body,
          headers: item.headers || [],
        });
        close();
      });
      row.appendChild(labelEl);

      if (isSaved) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'query-history-remove';
        remove.textContent = '×';
        /** @type {any} */ (window).__setTooltip(remove, 'Remove saved request');
        remove.addEventListener('click', (e) => {
          e.stopPropagation();
          saved = saved.filter((s) => s !== item);
          vscode.postMessage({ type: 'saveRestCallSavedRequests', savedRequests: saved });
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
  /** @param {{ history?: RestHistoryEntry[], savedRequests?: SavedRestCall[] }} state */
  function load(state) {
    history = Array.isArray(state.history) ? state.history : [];
    saved = Array.isArray(state.savedRequests) ? state.savedRequests : [];
    if (open) render();
  }

  /** Called only on a completed run (success — including non-2xx — never on send). */
  /** @param {{ method: string, endpoint: string, body: string, headers: HeaderEntry[] }} entry */
  function recordRun(entry) {
    if (!entry.endpoint.trim()) return;
    vscode.postMessage({ type: 'addRestCallHistory', ...entry });
  }

  /** @param {RestHistoryEntry[]} list */
  function onHistoryUpdated(list) {
    history = Array.isArray(list) ? list : [];
    if (open) render();
  }

  /** @param {SavedRestCall[]} list */
  function onSavedUpdated(list) {
    saved = Array.isArray(list) ? list : [];
    if (open) render();
  }

  return { load, recordRun, onHistoryUpdated, onSavedUpdated };
}

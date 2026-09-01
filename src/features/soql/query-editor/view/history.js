// @ts-check
// Query history dropdown for the SOQL tab: a "History ▾" button that
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
 * @property {(entry: { query: string, useToolingApi: boolean, name?: string }) => void} onPick
 *   `name` is set only for a Saved pick — Recent entries carry no name.
 * @property {() => string} [getDefaultName]  Name to pre-fill the save input with —
 *   the active tab's own title, whether auto-derived, hand-renamed or adopted from a
 *   saved entry. Pre-selected, so typing still replaces it.
 * @property {(name: string) => void} [onSaved]  Called once a Save is confirmed, with
 *   the name it was saved under — lets the caller relabel the tab that was just saved
 *   to match, so the box the user just typed a name into and the tab they're looking
 *   at never disagree.
 */

/** @param {QueryHistoryCtx} ctx */
export function createQueryHistory(ctx) {
  const { buttonEl, dropdownEl, saveBtn, vscode, getCurrent, onPick, getDefaultName, onSaved } =
    ctx;

  /** @type {HistoryEntry[]} */
  let history = [];
  /** @type {SavedQuery[]} */
  let saved = [];
  let open = false;
  let showSaveRow = false;
  // The two section nodes currently in the panel, so a list change can replace
  // just those — see refreshSections().
  /** @type {HTMLElement | null} */
  let savedSection = null;
  /** @type {HTMLElement | null} */
  let recentSection = null;

  function close() {
    open = false;
    showSaveRow = false;
    savedSection = null;
    recentSection = null;
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

    savedSection = buildSection('Saved', saved, true);
    recentSection = buildSection('Recent', history, false);
    dropdownEl.appendChild(savedSection);
    dropdownEl.appendChild(recentSection);
  }

  /**
   * Repaint the two lists WITHOUT rebuilding the save row.
   *
   * A full render() destroys the save input, so re-rendering on a host push
   * discarded whatever the user was typing and re-seeded the box from
   * getDefaultName(). Reachable in one ordinary sequence: run a query, open
   * ★ Save while it is still in flight, type — the result lands, recordRun
   * posts addQueryHistory, the host echoes the updated list back, and the name
   * is gone. So every "the list changed" path comes through here instead;
   * toggle / ★ Save / commit / Escape still full-render, because each of those
   * is itself a change to whether the save row should exist at all.
   *
   * Deliberately replaces the two sections in place rather than wrapping them
   * in a container: `.query-history-section + .query-history-section`
   * (media/main.css) is an adjacent-sibling rule, and a wrapper would break the
   * divider between them.
   */
  function refreshSections() {
    if (!open) return;
    if (!savedSection || !recentSection) {
      render();
      return;
    }
    const nextSaved = buildSection('Saved', saved, true);
    const nextRecent = buildSection('Recent', history, false);
    savedSection.replaceWith(nextSaved);
    recentSection.replaceWith(nextRecent);
    savedSection = nextSaved;
    recentSection = nextRecent;
  }

  function buildSaveRow() {
    const row = document.createElement('div');
    row.className = 'query-history-save-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'query-history-save-input';
    input.placeholder = 'Name this query…';
    input.value = (getDefaultName?.() ?? '').trim();
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
      onSaved?.(name);
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
    // Focus AND select: the pre-filled tab name is a suggestion, so typing over it
    // has to be as cheap as accepting it.
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
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
      /** @type {any} */ (window).__setTooltip(label, item.query);
      label.addEventListener('click', () => {
        onPick({
          query: item.query,
          useToolingApi: item.useToolingApi,
          name: isSaved ? safeItem.name : undefined,
        });
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
        /** @type {any} */ (window).__setTooltip(remove, 'Remove saved query');
        remove.addEventListener('click', (e) => {
          e.stopPropagation();
          saved = saved.filter((s) => s !== item);
          vscode.postMessage({ type: 'saveSavedQueries', savedQueries: saved });
          refreshSections();
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
    refreshSections();
  }

  /** @param {string} query @param {boolean} useToolingApi */
  function recordRun(query, useToolingApi) {
    if (!query.trim()) return;
    vscode.postMessage({ type: 'addQueryHistory', query, useToolingApi });
  }

  /** @param {HistoryEntry[]} list */
  function onHistoryUpdated(list) {
    history = Array.isArray(list) ? list : [];
    refreshSections();
  }

  /** @param {SavedQuery[]} list */
  function onSavedUpdated(list) {
    saved = Array.isArray(list) ? list : [];
    refreshSections();
  }

  return { load, recordRun, onHistoryUpdated, onSavedUpdated };
}

// @ts-check
// "History ▾" dropdown for the Overview tab's "Ask the AI" chat — lists past
// archived conversations (see AskAiHistoryStore host-side). Modeled directly
// on the SOQL tab's query-editor/history.js, collapsed to a single unnamed
// section (every entry is always removable — there's no Saved/Recent split
// here, since conversations are archived automatically, never hand-saved).

/**
 * @typedef {{ id: string, title: string, updatedAt: number }} ConversationSummary
 */

/**
 * @typedef {Object} AskAiHistoryCtx
 * @property {HTMLButtonElement} buttonEl     "History ▾" toggle.
 * @property {HTMLElement} dropdownEl         Container for the panel.
 * @property {{ postMessage: (msg: any) => void }} vscode
 * @property {(id: string) => void} onPick    Called when a conversation row is clicked.
 */

/** @param {AskAiHistoryCtx} ctx */
export function createAskAiHistory(ctx) {
  const { buttonEl, dropdownEl, vscode, onPick } = ctx;

  /** @type {ConversationSummary[]} */
  let conversations = [];
  let open = false;

  function close() {
    open = false;
    dropdownEl.style.display = 'none';
  }

  function toggle() {
    open = !open;
    if (open) render();
    else close();
  }

  /** @param {string} text */
  function truncate(text) {
    const oneLine = text.replace(/\s+/g, ' ').trim();
    return oneLine.length > 70 ? oneLine.slice(0, 70) + '…' : oneLine;
  }

  /** @param {number} timestamp */
  function formatTimestamp(timestamp) {
    const date = new Date(timestamp);
    return (
      date.toLocaleDateString() +
      ' ' +
      date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    );
  }

  function render() {
    dropdownEl.innerHTML = '';
    dropdownEl.style.display = '';

    const section = document.createElement('div');
    section.className = 'query-history-section';

    const header = document.createElement('div');
    header.className = 'query-history-section-title';
    header.textContent = `Conversations (${conversations.length})`;
    section.appendChild(header);

    if (conversations.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'query-history-empty';
      empty.textContent = 'No past conversations yet.';
      section.appendChild(empty);
      dropdownEl.appendChild(section);
      return;
    }

    for (const entry of conversations) {
      const row = document.createElement('div');
      row.className = 'query-history-item';

      const label = document.createElement('span');
      label.className = 'query-history-item-label';
      label.textContent = `${truncate(entry.title)} · ${formatTimestamp(entry.updatedAt)}`;
      /** @type {any} */ (window).__setTooltip(label, entry.title);
      label.addEventListener('click', () => {
        onPick(entry.id);
        close();
      });
      row.appendChild(label);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'query-history-remove';
      remove.textContent = '×';
      /** @type {any} */ (window).__setTooltip(remove, 'Delete this conversation');
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        conversations = conversations.filter((c) => c.id !== entry.id);
        vscode.postMessage({ type: 'deleteAskAiConversation', id: entry.id });
        render();
      });
      row.appendChild(remove);

      section.appendChild(row);
    }
    dropdownEl.appendChild(section);
  }

  // ── Wiring ──────────────────────────────────────────────────────────────────
  buttonEl.addEventListener('click', (e) => {
    e.stopPropagation();
    toggle();
  });
  document.addEventListener('click', (e) => {
    if (open && !dropdownEl.contains(/** @type {Node} */ (e.target)) && e.target !== buttonEl) {
      close();
    }
  });

  // ── Public API ──────────────────────────────────────────────────────────────
  /** @param {ConversationSummary[]} list */
  function onHistoryUpdated(list) {
    conversations = Array.isArray(list) ? list : [];
    if (open) render();
  }

  function refresh() {
    vscode.postMessage({ type: 'loadAskAiHistory' });
  }

  return { onHistoryUpdated, refresh };
}

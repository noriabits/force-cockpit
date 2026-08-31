// @ts-check
// Config persistence sync for the monitoring dashboard: requests configs from
// the host, sorts them by position (id tiebreak) and hands them to the
// orchestrator via `applyConfigs` (which owns the `configs` variable + render),
// renders the "Restore hidden built-ins" link, and owns the load-error box +
// delete result/error handling. No state of its own — DOM refs and the
// apply-configs callback come in via ctx.

/**
 * @typedef {Object} ConfigLoaderCtx
 * @property {any} labels
 * @property {{ postMessage: (msg: any) => void }} vscode
 * @property {HTMLElement} loadErrorEl
 * @property {HTMLElement} monitoringPanel
 * @property {() => void} drainEditForms  Drain every open edit form. Called from
 *   `onConfigsLoaded` only — see the note there for why it is not called at the
 *   point the reload is *requested*.
 * @property {(requestId: unknown) => ({ fail: (m: string) => void, settle: () => void } | undefined)}
 *   resolveReply  What to do with the reply to this request, matched to the form
 *   that minted the id — `undefined` if nothing is waiting on it.
 * @property {(sortedConfigs: any[]) => void} applyConfigs
 */

/**
 * @param {ConfigLoaderCtx} ctx
 */
export function createConfigLoader(ctx) {
  const {
    labels: L,
    vscode,
    loadErrorEl,
    monitoringPanel,
    drainEditForms,
    resolveReply,
    applyConfigs,
  } = ctx;

  function loadConfigs() {
    hideLoadError();
    vscode.postMessage({ type: 'loadMonitoringConfigs' });
  }

  /**
   * @param {any[]} newConfigs
   * @param {number} hiddenCount
   */
  function onConfigsLoaded(newConfigs, hiddenCount) {
    const sorted = newConfigs.slice().sort((a, b) => {
      const pa = a.position ?? Infinity;
      const pb = b.position ?? Infinity;
      if (pa !== pb) return pa - pb;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    // Drain every open edit form HERE, not where the reload was requested.
    // `applyConfigs` is the one point the grid is actually wiped, and the
    // request can fail (`loadMonitoringConfigsError` -> showLoadError) with the
    // grid left intact — draining at request time would then leave a live form
    // whose folder combobox has lost its `input -> folder.value` sync, so the
    // category field keeps accepting keystrokes while the signal goes stale and
    // the next Save silently writes the OLD folder. Same reasoning that keeps
    // Delete's drain on the confirmed reply rather than on the post.
    drainEditForms();
    applyConfigs(sorted);
    renderRestoreHiddenLink(hiddenCount);
  }

  /** @param {number} hiddenCount */
  function renderRestoreHiddenLink(hiddenCount) {
    const existing = document.getElementById('monitoring-restore-hidden');
    if (existing) existing.remove();
    if (hiddenCount <= 0) return;
    const toolbarTop = monitoringPanel.querySelector('.monitoring-toolbar-top');
    if (!toolbarTop) return;
    const btn = document.createElement('button');
    btn.id = 'monitoring-restore-hidden';
    btn.className = 'btn btn-link monitoring-restore-hidden';
    btn.textContent =
      typeof L.btnRestoreHidden === 'function'
        ? L.btnRestoreHidden(hiddenCount)
        : `Restore hidden built-ins (${hiddenCount})`;
    btn.addEventListener('click', () => {
      vscode.postMessage({ type: 'restoreHiddenBuiltins' });
    });
    toolbarTop.insertBefore(btn, toolbarTop.firstChild);
  }

  /** @param {any} data */
  function onDeleteResult(data) {
    // Settle FIRST, on both branches: this reply is terminal for the delete
    // either way, so the form stops waiting on it here and not somewhere
    // downstream. Mirrors `onSaveResult`.
    //
    // The confirmed branch used to skip this and lean on the drain in
    // `onConfigsLoaded` — but that only runs if the reload SUCCEEDS. A
    // `loadMonitoringConfigsError` leaves the grid and the form standing by
    // design, and the entry then outlived the request that armed it, which is
    // exactly the state `armReply`'s one-shot contract exists to rule out.
    //
    // Nothing misroutes as a result — entries are matched by `requestId`, so a
    // finished one can never be claimed by a later reply; it is inert, and the
    // next successful reload clears it via the drain. The reason to settle is
    // that the invariant should be true rather than merely harmless to break,
    // and that a reader should not have to work out why the two paths differ.
    if (data) resolveReply(data.requestId)?.settle();
    // `deleted === false` means the user dismissed the native confirmation.
    // Nothing was deleted, so no reload — and NO drain: the form stays on
    // screen and must keep its listeners, or the folder combobox loses its
    // `input -> folder.value` sync and the next Save writes the OLD category.
    if (!data || data.deleted === false) return;
    // Confirmed. The drain runs in onConfigsLoaded, once the reply that actually
    // rebuilds the grid arrives — see the note there.
    loadConfigs();
  }

  /**
   * Matched by `requestId` to the form that asked for this delete.
   *
   * Two earlier versions got this wrong in the same way: the first borrowed the
   * SAVE hook (which only Save ever arms, so a delete error on a never-saved
   * form fell through to the grid-level box), and the second took "the first
   * card still waiting" — sound only while at most one form is waiting, which
   * is not guaranteed. The id makes it exact.
   *
   * Falls back to the grid-level error box when nothing is waiting on it: the
   * form was cancelled or rebuilt away, and the message would otherwise vanish.
   *
   * @param {any} data
   */
  function onDeleteError(data) {
    const reply = data && resolveReply(data.requestId);
    if (reply) reply.fail(data.message);
    else showLoadError(data ? data.message : '');
  }

  /** @param {string} msg */
  function showLoadError(msg) {
    loadErrorEl.textContent = msg;
    loadErrorEl.style.display = '';
  }

  function hideLoadError() {
    loadErrorEl.style.display = 'none';
    loadErrorEl.textContent = '';
  }

  return { loadConfigs, onConfigsLoaded, onDeleteResult, onDeleteError, showLoadError };
}

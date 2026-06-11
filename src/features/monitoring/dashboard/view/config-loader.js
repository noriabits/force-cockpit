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
 * @property {HTMLElement} grid
 * @property {(sortedConfigs: any[]) => void} applyConfigs
 */

/**
 * @param {ConfigLoaderCtx} ctx
 */
export function createConfigLoader(ctx) {
  const { labels: L, vscode, loadErrorEl, monitoringPanel, grid, applyConfigs } = ctx;

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
    if (!data || data.deleted === false) return;
    loadConfigs();
  }

  /** @param {string} errMsg */
  function onDeleteError(errMsg) {
    const card = /** @type {any} */ (grid.querySelector('.card:has(.monitoring-edit-form)'));
    if (card && card.__pendingSaveError) {
      card.__pendingSaveError(errMsg);
    } else {
      showLoadError(errMsg);
    }
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

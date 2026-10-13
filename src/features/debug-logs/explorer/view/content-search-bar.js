// @ts-check
// "Search inside logs" on Enter in the list's own filter box: the batched
// round trips to the host and the progress line. Typing still filters the
// row columns instantly (log-list.js); Enter ALSO scans every listed log's
// body, and the list then shows a row whose columns OR content match. A body
// search is up to 200 downloads, which is why it never runs per keystroke. The loop lives here (one batch per reply, like the SOQL
// tab's query-paging.js), so a cancel is simply not asking again.
import { applyBatch, failSearch, nextBatch, startSearch, unsearchedCount } from './content-search';

/**
 * @param {{
 *   labels: any,
 *   vscode: { postMessage: (msg: any) => void },
 *   getConnected: () => boolean,
 *   getLogIds: () => string[],
 *   onChange: () => void,
 * }} ctx
 */
export function createContentSearchBar(ctx) {
  const { labels, vscode } = ctx;
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

  const input = /** @type {HTMLInputElement} */ ($('dbg-log-filter'));
  const cancelBtn = /** @type {HTMLButtonElement} */ ($('dbg-content-search-cancel'));
  const statusEl = $('dbg-content-search-status');

  /** @type {import('./content-search').ContentSearch | null} */ let search = null;
  /** @type {string | null} */ let opId = null;
  let batchSize = 0;
  let seq = 0;
  let stopped = false;

  function post(/** @type {string} */ type, /** @type {string} */ id) {
    vscode.postMessage({ type, opId: id });
  }

  /** Ask for the next batch, or settle when every listed log has been scanned. */
  function sendNext() {
    if (!search) return;
    const batch = nextBatch(search);
    if (!batch.length) return;
    // Namespaced so no other module's reply can be mistaken for ours.
    opId = `dbgsearch-${++seq}`;
    batchSize = batch.length;
    vscode.postMessage({ type: 'searchApexLogBodies', logIds: batch, query: search.query, opId });
    post('operationStarted', opId);
  }

  /** End the in-flight batch, if any — the host aborts it and posts nothing. */
  function abandon() {
    if (!opId) return;
    post('cancelOperation', opId);
    post('operationEnded', opId);
    opId = null;
  }

  function statusText() {
    if (!search) return input.value.trim() ? labels.searchHint : '';
    if (search.error) return labels.searchFailed(search.error);
    const matched = search.matches.size;
    const total = search.ids.length;
    if (opId) return labels.searchProgress(search.scanned, total, matched);
    if (stopped) return labels.searchStopped(search.scanned, total, matched);
    const fresh = unsearchedCount(search, ctx.getLogIds());
    return (
      labels.searchDone(matched, total) + (fresh ? ` · ${labels.searchNotScanned(fresh)}` : '')
    );
  }

  function paint() {
    cancelBtn.style.display = opId ? '' : 'none';
    statusEl.textContent = statusText();
  }

  function start() {
    const query = input.value.trim();
    if (!query) {
      clear();
      return;
    }
    if (!ctx.getConnected()) {
      statusEl.textContent = labels.notConnected;
      return;
    }
    abandon();
    stopped = false;
    search = startSearch(query, ctx.getLogIds());
    sendNext();
    paint();
    ctx.onChange();
  }

  function stop() {
    if (!opId) return;
    abandon();
    stopped = true;
    paint();
  }

  function clear() {
    abandon();
    search = null;
    stopped = false;
    paint();
    ctx.onChange();
  }

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') start();
  });
  input.addEventListener('input', () => {
    // Body results belong to the text they were searched for — editing it
    // drops them (and stops a sweep still running) until the next Enter.
    if (search && input.value.trim() !== search.query) clear();
    else paint();
  });
  cancelBtn.addEventListener('click', stop);

  paint();

  return {
    matchOf: (/** @type {string} */ id) => search?.matches.get(id) ?? null,
    getQuery: () => search?.query ?? '',
    /** Re-render the status line (the list changed under a finished search). */
    paint,
    onResult(/** @type {any} */ data) {
      if (!search || !opId || data.opId !== opId) return; // stale or cancelled
      post('operationEnded', opId);
      opId = null;
      applyBatch(search, batchSize, data.matches ?? []);
      sendNext();
      paint();
      ctx.onChange();
    },
    onError(/** @type {any} */ data) {
      if (!search || !opId || data.opId !== opId) return;
      post('operationEnded', opId);
      opId = null;
      failSearch(search, data.message ?? '');
      paint();
      ctx.onChange();
    },
    /** `cancelAllOperations` — keep what was found, stop asking. */
    stop,
    /**
     * Org change: the previous org's body matches mean nothing here. The
     * filter text is the list's and stays, as it always has.
     */
    reset: clear,
  };
}

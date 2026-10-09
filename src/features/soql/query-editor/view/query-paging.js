// @ts-check
// Loads the rest of a large SOQL result in the background. Salesforce answers a
// query with its first batch (≤ 2000 rows); when more exist, this module asks for
// the next batch after each reply until the result is complete or
// MAX_LOADED_ROWS is reached. The host returns ONE batch per `queryMore`, so
// every batch crosses postMessage on its own, and a cancel between batches is
// nothing more than not asking again.
//
// Each batch is an ordinary per-tab run: its opId goes on the tab that asked
// (tab-strip.js), so a reply always lands in that tab and is dropped once the tab
// is closed or stopped — the same rules as a query run, via the same `ownerOf`.
//
// Only the locator and the API flag go to the host. Never the rows: the
// dispatcher echoes the whole request back onto the reply.
import { mergeBatch, shouldFetchNext } from './paging';

/**
 * @typedef {Object} QueryPagingCtx
 * @property {{ postMessage: (msg: any) => void }} vscode
 * @property {any} tabs The query tab strip.
 * @property {() => string} nextOpId Mints an id in the query runner's namespace.
 * @property {(tab: any) => void} onProgress A batch landed and another is on its way.
 * @property {(tab: any) => void} onSettled Loading stopped: complete, at the row limit, or failed.
 */

/** @param {QueryPagingCtx} ctx */
export function createQueryPaging(ctx) {
  const { vscode, tabs } = ctx;

  /** @type {Set<string>} opIds of in-flight batches */
  const pending = new Set();

  /**
   * Ask for the batch after the one `tab` holds. Returns false when there is
   * nothing to ask for — the result is complete or at the row limit.
   * @param {any} tab
   */
  function continueLoading(tab) {
    const results = tab?.results;
    if (!results || !shouldFetchNext(results) || tab.opId) return false;
    const opId = ctx.nextOpId();
    pending.add(opId);
    tabs.setActiveOpId(opId, tab);
    vscode.postMessage({
      type: 'queryMore',
      locator: results.nextRecordsUrl,
      // The API the first batch actually ran on — not the checkbox, which may
      // have been toggled since.
      useToolingApi: !!results.useToolingApi,
      opId,
    });
    vscode.postMessage({ type: 'operationStarted', opId });
    return true;
  }

  /** @param {{ tab: any, opId: string }} owner @param {any} data */
  function onResult({ tab, opId }, data) {
    pending.delete(opId);
    tabs.settleRun(tab, mergeBatch(tab.results, data), null);
    if (continueLoading(tab)) ctx.onProgress(tab);
    else ctx.onSettled(tab);
  }

  /**
   * The rows already loaded stay; the failure rides on them so it survives a
   * tab switch. A locator expires after ~15 minutes idle, and re-running the
   * query is then the only way on.
   * @param {{ tab: any, opId: string }} owner @param {any} data
   */
  function onError({ tab, opId }, data) {
    pending.delete(opId);
    tabs.settleRun(tab, { ...tab.results, pagingError: data.message }, null);
    ctx.onSettled(tab);
  }

  /** @param {string | null | undefined} opId */
  function isPaging(opId) {
    return !!opId && pending.has(opId);
  }

  /** Drop a stopped batch. @param {string | null | undefined} opId */
  function forget(opId) {
    if (opId) pending.delete(opId);
  }

  return { continueLoading, onResult, onError, isPaging, forget };
}

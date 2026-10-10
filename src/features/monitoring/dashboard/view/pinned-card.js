// @ts-check
// A chart pinned from the SOQL tab (📌 Pin to Monitoring) arriving in the grid.
//
// The SOQL tab posts `saveMonitoringConfig` itself, and every save reply
// reaches this webview too (main.js runs both message buses for every type).
// No edit form owns a pin's requestId, so the ordinary save path would take its
// unowned-reply fallback — `loadConfigs()`, a full grid rebuild that tears out
// every open edit form, unsaved edits included. A pin is recognised by the
// `origin` the SOQL tab put on the request (echoed back onto the reply) and its
// card is appended in place instead.
//
// The user is on the SOQL tab when this happens, so the monitoring panel is
// hidden: a chart created in a display:none container gets 0×0 dimensions and
// no colours. Those queries wait in `pending` until the panel is visible —
// the same reason `index.js` defers the initial load.

/** @param {any} data A save reply or error payload */
export function isPinReply(data) {
  return Boolean(data) && data.origin === 'soql-pin';
}

/**
 * @param {{
 *   grid: HTMLElement,
 *   getConfigs: () => any[],
 *   buildViewCard: (cfg: any) => HTMLElement,
 *   triggerQuery: (cfg: any) => void,
 *   getConnected: () => boolean,
 *   isPanelVisible: () => boolean,
 *   afterInsert: () => void,
 * }} ctx
 */
export function createPinnedCards(ctx) {
  /** @type {any[]} */
  let pending = [];

  /** @param {any} saved The persisted record the host returned */
  function insert(saved) {
    const configs = ctx.getConfigs();
    // Defensive: the host's createOnly guard means a pin never replaces a
    // chart, but a duplicate entry would render twice and confuse drag-order.
    if (configs.some((c) => c.id === saved.id)) return;
    configs.push(saved);
    ctx.grid.appendChild(ctx.buildViewCard(saved));
    ctx.afterInsert();
    if (!ctx.getConnected()) return;
    if (ctx.isPanelVisible()) ctx.triggerQuery(saved);
    else pending.push(saved);
  }

  /** Run the queries of pins that arrived while the panel was hidden. */
  function flushPending() {
    const due = pending;
    pending = [];
    if (!ctx.getConnected()) return;
    for (const cfg of due) ctx.triggerQuery(cfg);
  }

  /** A full grid rebuild re-queries everything, so nothing is left owing. */
  function clearPending() {
    pending = [];
  }

  return { insert, flushPending, clearPending };
}

// @ts-check
// The plugin SDK + the Plugins tab's sub-tab switching.
//
//   - win.__fcPlugin(id) → the API object a plugin's view.js talks to
//
// A plugin's view.js is authored by a user, unbundled, and cannot import from
// src/. Everything it needs therefore has to arrive on `window`, and it should
// never touch the raw message bus: this module owns the single subscription to
// pluginResult/pluginError and routes replies back by opId.
//
// Load order: after ipc.js and action-tracker.js (it uses __onMessage and
// __startAction), before the plugin <script type="module"> tags — which are
// appended to </body> and deferred, so any position in WEBVIEW_MODULES works.

(function () {
  const win = /** @type {any} */ (window);
  const vscode = win.__vscode;

  // ── Sub-tab switching ────────────────────────────────────────────────────
  // Deliberately a second copy of utils-subtab.js's first block rather than a
  // shared factory: it is ~15 lines and there are two consumers. If a third
  // sub-tab bar appears, extract then.
  const bar = document.getElementById('plugin-sub-tab-bar');
  const emptyState = document.getElementById('plugins-empty-state');

  function activate(/** @type {string} */ id) {
    if (!bar) return;
    bar.querySelectorAll('.plugin-sub-tab').forEach((t) => t.classList.remove('active'));
    bar
      .querySelector('.plugin-sub-tab[data-plugin-tab="' + CSS.escape(id) + '"]')
      ?.classList.add('active');
    document.querySelectorAll('.plugin-sub-tab-panel').forEach((p) => p.classList.remove('active'));
    document.getElementById('plugin-sub-tab-' + id)?.classList.add('active');
  }

  if (bar) {
    bar.addEventListener('click', (e) => {
      const btn = /** @type {HTMLElement} */ (e.target);
      if (!btn.classList.contains('plugin-sub-tab') || btn.classList.contains('active')) return;
      const id = btn.getAttribute('data-plugin-tab');
      if (id) activate(id);
    });

    const first = bar.querySelector('.plugin-sub-tab');
    if (first) {
      if (emptyState) emptyState.style.display = 'none';
      activate(/** @type {string} */ (first.getAttribute('data-plugin-tab')));
    }
  }

  // ── invoke() plumbing ────────────────────────────────────────────────────
  /** @type {Map<string, { resolve: (v: any) => void, reject: (e: Error) => void, onChunk?: (c: string) => void }>} */
  const pending = new Map();
  // Disjoint from action-tracker's `op-N`, the SOQL runner's `soql-N` and the
  // REST tab's `rest-N`, so no other module can ever claim a plugin's reply.
  let seq = 0;

  function settle(/** @type {string} */ opId, /** @type {(p: any) => void} */ apply) {
    const entry = pending.get(opId);
    if (!entry) return; // cancelled, or never ours
    pending.delete(opId);
    apply(entry);
  }

  win.__onMessage('pluginResult', (/** @type {any} */ msg) => {
    const data = msg.data ?? {};
    settle(data.opId, (e) => e.resolve(data.result));
  });

  win.__onMessage('pluginError', (/** @type {any} */ msg) => {
    const data = msg.data ?? {};
    settle(data.opId, (e) => e.reject(new Error(data.message || 'Plugin call failed.')));
  });

  win.__onMessage('scriptLogChunk', (/** @type {any} */ msg) => {
    const data = msg.data ?? {};
    pending.get(data.opId)?.onChunk?.(data.chunk);
  });

  function rejectAll(/** @type {string} */ reason) {
    for (const [opId, entry] of pending) {
      pending.delete(opId);
      entry.reject(new Error(reason));
    }
  }

  // An org switch cancels everything host-side; a plugin awaiting a reply that
  // will never come must not hang forever.
  win.__onMessage('cancelAllOperations', () => rejectAll('Operation cancelled'));

  /**
   * The object a plugin's view.js works with.
   * @param {string} pluginId
   */
  win.__fcPlugin = function (pluginId) {
    return {
      pluginId,

      /**
       * Call a handler exported by this plugin's handlers.js.
       *
       * Pass `button` to get the spinner, the ✕ Cancel button and the
       * operationStarted/Ended accounting that makes an org switch warn — all
       * of it from the same __startAction every built-in feature uses.
       *
       * @param {string} handler
       * @param {unknown} [args]
       * @param {{ button?: HTMLButtonElement, onChunk?: (chunk: string) => void }} [options]
       * @returns {Promise<any>}
       */
      invoke(handler, args, options) {
        const opts = options ?? {};
        return new Promise((resolve, reject) => {
          /** @type {string} */
          let opId;
          if (opts.button) {
            opId = win.__startAction(opts.button, () => {
              vscode.postMessage({ type: 'cancelOperation', opId });
              settle(opId, (e) => e.reject(new Error('Operation cancelled')));
            });
          } else {
            opId = 'plugin-' + ++seq;
            vscode.postMessage({ type: 'operationStarted', opId });
          }

          pending.set(opId, {
            resolve: (v) => {
              finish(opId, opts.button);
              resolve(v);
            },
            reject: (e) => {
              finish(opId, opts.button);
              reject(e);
            },
            onChunk: opts.onChunk,
          });

          vscode.postMessage({ type: 'pluginInvoke', opId, pluginId, handler, args: args ?? {} });
        });
      },

      /** Register for org connect/disconnect, via the shared feature registry. */
      onOrg(
        /** @type {{ onConnected?: (org: any) => void, onDisconnected?: () => void }} */ hooks,
      ) {
        win.__registerFeature('plugin:' + pluginId, {
          onOrgConnected: hooks.onConnected,
          onOrgDisconnected: hooks.onDisconnected,
        });
      },

      /** True once an org is connected — plugins usually gate their UI on this. */
      get connected() {
        return Boolean(win.__orgConnected);
      },
      get org() {
        return win.__currentOrg ?? null;
      },

      escapeHtml: win.__escapeHtml,
      setTooltip: win.__setTooltip,
      /** Open a Salesforce record in the browser. */
      openRecord: (/** @type {string} */ recordId) =>
        vscode.postMessage({ type: 'openRecord', recordId }),
      /** Native "are you sure" modal, with no org-sensitivity gate. */
      confirm: (/** @type {string} */ prompt) =>
        new Promise((resolve) =>
          win.__confirmAction(
            prompt,
            () => resolve(true),
            () => resolve(false),
          ),
        ),
    };
  };

  function finish(/** @type {string} */ opId, /** @type {HTMLButtonElement | undefined} */ button) {
    if (button) win.__endAction(opId);
    else vscode.postMessage({ type: 'operationEnded', opId });
  }
})();

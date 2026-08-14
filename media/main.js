// @ts-check
// Force Cockpit — Webview Bootstrap
// Runs inside the VSCode webview. Each concern lives in its own module under
// media/modules/* — see MainPanel._getHtml() for the load order. This bootstrap
// only wires up the top-level message listener and signals readiness.

(function () {
  const win = /** @type {any} */ (window);
  const vscode = win.__vscode;

  window.addEventListener('message', (event) => {
    const message = event.data;

    // Drop late results from operations the user already cancelled
    if (message.opId && win.__isOpCancelled && win.__isOpCancelled(message.opId)) {
      win.__clearCancelledOp(message.opId);
      return;
    }

    // Both registries always run: a message type is a broadcast, not a claim.
    // These two are parallel buses (module scripts use __onMessage, feature
    // scripts use __registerFeature), and several host replies legitimately
    // have consumers on both — listChatModelsResult feeds the SOQL AI panel
    // (module) as well as Ask AI / Debug Logs / YAML scripts (features), and
    // scriptLogChunk is a shared streaming channel that every AI surface
    // filters by its own opId. Returning early when the module registry
    // matched used to starve every feature-side consumer of those types.
    win.__dispatchMessage(message);

    // Each handler is isolated: one feature throwing must not stop the features
    // registered after it in this loop — that is the same starvation the early
    // return above used to cause, just from a different direction.
    Object.values(win.__featureHandlers).forEach((/** @type {any} */ h) => {
      if (!h.onMessage) return;
      try {
        h.onMessage(message);
      } catch (err) {
        console.error('[force-cockpit] feature message handler failed', message.type, err);
      }
    });
  });

  // Signal to the extension host that the webview is fully initialized and its
  // message listener is in place. Extension host will respond with orgConnected
  // or orgDisconnected based on current connection state.
  vscode.postMessage({ type: 'ready' });
})();

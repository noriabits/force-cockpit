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

    // Route via the module registry first; fall through to feature handlers.
    const handled = win.__dispatchMessage(message);
    if (handled) return;

    Object.values(win.__featureHandlers).forEach(
      (/** @type {any} */ h) => h.onMessage && h.onMessage(message),
    );
  });

  // Signal to the extension host that the webview is fully initialized and its
  // message listener is in place. Extension host will respond with orgConnected
  // or orgDisconnected based on current connection state.
  vscode.postMessage({ type: 'ready' });
})();

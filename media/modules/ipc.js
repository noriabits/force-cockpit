// @ts-check
// IPC primitives shared by all webview modules and feature scripts.
//   - win.__vscode          : VSCode webview API (single instance)
//   - win.__escapeHtml      : HTML escaper returning '' for null/undefined
//   - win.__registerFeature : feature scripts call this with { onOrgConnected, onOrgDisconnected, onMessage }
//   - win.__featureHandlers : map of { [featureId]: handler }
//   - win.__onMessage       : modules register typed handlers via __onMessage(type, handler)
//   - win.__dispatchMessage : main.js calls this to route a message to registered handlers
// Load order: must be the FIRST webview module — everything else depends on these globals.

(function () {
  const win = /** @type {any} */ (window);

  // @ts-ignore — acquireVsCodeApi is injected by the VSCode webview runtime
  const vscode = acquireVsCodeApi();
  Object.defineProperty(window, '__vscode', { value: vscode, writable: false });

  win.__escapeHtml = function (/** @type {unknown} */ str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  };

  win.__featureHandlers = {};
  win.__registerFeature = function (/** @type {string} */ id, /** @type {any} */ handler) {
    win.__featureHandlers[id] = handler;
  };

  /** @type {Map<string, Set<(msg: any) => void>>} */
  const _messageHandlers = new Map();

  win.__onMessage = function (
    /** @type {string} */ type,
    /** @type {(msg: any) => void} */ handler,
  ) {
    let set = _messageHandlers.get(type);
    if (!set) {
      set = new Set();
      _messageHandlers.set(type, set);
    }
    set.add(handler);
  };

  /** @returns {boolean} true if at least one handler matched */
  win.__dispatchMessage = function (/** @type {any} */ message) {
    const handlers = _messageHandlers.get(message.type);
    if (!handlers) return false;
    for (const h of handlers) h(message);
    return true;
  };
})();

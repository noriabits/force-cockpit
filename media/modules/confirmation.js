// @ts-check
// Sensitive-org confirmation utility. window.confirm() is blocked in VSCode webviews;
// features call win.__confirmIfSensitive(orgData, label, onConfirmed, onCancelled) and
// the extension host shows a native modal via vscode.window.showWarningMessage.

(function () {
  const win = /** @type {any} */ (window);
  const vscode = win.__vscode;

  /** @type {Map<string, { onConfirmed: () => void; onCancelled?: () => void }>} */
  const _pendingConfirmations = new Map();
  let _confirmSeq = 0;

  win.__confirmIfSensitive = function (
    /** @type {any} */ orgData,
    /** @type {string} */ actionLabel,
    /** @type {() => void} */ onConfirmed,
    /** @type {(() => void) | undefined} */ onCancelled,
  ) {
    const isSensitive = (orgData && !orgData.sandboxName) || !!orgData?.isProtectedOrg;
    if (!isSensitive) {
      onConfirmed();
      return;
    }
    const orgLabel = !orgData.sandboxName ? 'a Production org' : 'a protected sandbox';
    const requestId = 'confirm-' + ++_confirmSeq;
    _pendingConfirmations.set(requestId, { onConfirmed, onCancelled });
    vscode.postMessage({
      type: 'confirmAction',
      requestId,
      prompt: `⚠️ You are connected to ${orgLabel}. ${actionLabel}`,
    });
  };

  win.__onMessage('confirmActionResult', (/** @type {any} */ message) => {
    const { confirmed, requestId } = message.data ?? {};
    const pending = requestId && _pendingConfirmations.get(requestId);
    if (pending) {
      _pendingConfirmations.delete(requestId);
      if (confirmed) pending.onConfirmed();
      else if (pending.onCancelled) pending.onCancelled();
    }
  });
})();

// @ts-check
// Generic action tracking: spinner, cancel button, opId registry.
//   - win.__startAction(btn, onCancel) → opId   : disables btn, adds spinner + Cancel, tracks op
//   - win.__endAction(opId)                       : re-enables btn, removes spinner
//   - win.__isOpCancelled(opId)                   : true if the op was cancelled (used to drop late results)
//   - win.__clearCancelledOp(opId)                : clears the cancelled flag
// Also handles the `cancelAllOperations` message posted by MainPanel when the user is asked to
// abort mid-run (e.g. switching orgs while an operation is in flight).

(function () {
  const win = /** @type {any} */ (window);
  const vscode = win.__vscode;

  /** @type {Map<string, { btn: HTMLButtonElement, cancelBtn: HTMLButtonElement, onCancel: () => void }>} */
  const _activeOps = new Map();
  /** @type {Set<string>} opIds whose late results should be silently dropped */
  const _cancelledOps = new Set();
  let _opSeq = 0;

  win.__startAction = function (
    /** @type {HTMLButtonElement} */ btn,
    /** @type {() => void} */ onCancel,
  ) {
    const opId = 'op-' + ++_opSeq;

    btn.disabled = true;
    btn.classList.add('running');

    const cancelBtn = /** @type {HTMLButtonElement} */ (document.createElement('button'));
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn-ghost action-cancel-btn';
    cancelBtn.textContent = '✕ Cancel';
    cancelBtn.addEventListener(
      'click',
      () => {
        _endActionById(opId);
        _cancelledOps.add(opId);
        onCancel();
      },
      { once: true },
    );

    btn.parentElement?.insertBefore(cancelBtn, btn.nextSibling);
    _activeOps.set(opId, { btn, cancelBtn, onCancel });
    vscode.postMessage({ type: 'operationStarted', opId, count: _activeOps.size });
    return opId;
  };

  win.__endAction = function (/** @type {string | null | undefined} */ opId) {
    if (opId) _endActionById(opId);
  };

  win.__isOpCancelled = function (/** @type {string} */ opId) {
    return _cancelledOps.has(opId);
  };

  win.__clearCancelledOp = function (/** @type {string} */ opId) {
    _cancelledOps.delete(opId);
  };

  /** @param {string} opId */
  function _endActionById(opId) {
    const op = _activeOps.get(opId);
    if (!op) return;
    _activeOps.delete(opId);
    op.btn.classList.remove('running');
    op.btn.disabled = false;
    op.cancelBtn.remove();
    vscode.postMessage({ type: 'operationEnded', opId, count: _activeOps.size });
  }

  win.__onMessage('cancelAllOperations', () => {
    for (const [opId, op] of _activeOps) {
      _cancelledOps.add(opId);
      op.cancelBtn.remove();
      op.btn.classList.remove('running');
      op.btn.disabled = false;
      op.onCancel();
    }
    _activeOps.clear();
    vscode.postMessage({ type: 'operationEnded', count: 0 });
  });

  // operationStarted/operationEnded are echoed to the webview for busy-tracking on the host side —
  // no webview action needed. Register no-ops so they don't fall through to feature handlers.
  win.__onMessage('operationStarted', () => {});
  win.__onMessage('operationEnded', () => {});
})();

// Tracks in-progress operations so the panel can guard org switches, cancel
// terminal commands mid-flight, and stay in sync with webview-side ops.
//
//   - Terminal ops: one AbortController per op, created when a feature route
//     fires a long-running command. `cancelOperation` (from the webview) or a
//     bulk `cancelAll()` (from the extension host) aborts them.
//   - Webview ops: a mirror Set of opIds announced by the webview via
//     `operationStarted` / `operationEnded`. Used by `hasActive` to decide
//     whether to prompt the user before disconnecting.

export class OperationRegistry {
  private readonly _terminalOps = new Map<string, AbortController>();
  private readonly _webviewOps = new Set<string>();

  get hasActive(): boolean {
    return this._webviewOps.size > 0;
  }

  // ── Terminal ops (host-side) ────────────────────────────────────────────

  createTerminalAbort(opId: string): AbortController {
    const ac = new AbortController();
    this._terminalOps.set(opId, ac);
    return ac;
  }

  endTerminalOp(opId: string): void {
    this._terminalOps.delete(opId);
  }

  cancelTerminalOp(opId: string): void {
    const ac = this._terminalOps.get(opId);
    if (ac) {
      ac.abort();
      this._terminalOps.delete(opId);
    }
  }

  // ── Webview ops (mirror) ────────────────────────────────────────────────

  startWebviewOp(opId: string): void {
    this._webviewOps.add(opId);
  }

  /** Pass an opId to remove just that one; omit to bulk-clear. */
  endWebviewOp(opId?: string): void {
    if (opId) this._webviewOps.delete(opId);
    else this._webviewOps.clear();
  }

  // ── Bulk cancel (e.g. org switch) ───────────────────────────────────────

  cancelAll(): void {
    for (const ac of this._terminalOps.values()) ac.abort();
    this._terminalOps.clear();
    this._webviewOps.clear();
  }
}

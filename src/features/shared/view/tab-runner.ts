// Per-tab run tracking for a tab strip whose tabs each run one request at a time
// — the part the REST and ▶️ Apex controllers used to carry as two copies, which
// had already drifted (REST assigned `tab.opId` directly and so never repainted
// the running pill). The Record Detail is the third consumer: it was not one
// while it had no tab strip and tracked a single run by hand.
//
// Like history-dropdown.tsx, the core POSTS NO FEATURE MESSAGE: `start` hands the
// minted opId to the binding's own `send`, which posts its request under its own
// literal name. The core posts only the three infrastructure names every run
// shares (`operationStarted` / `operationEnded` / `cancelOperation`).
//
// Hand-rolled rather than `win.__startAction` because that binds one opId to one
// button for the op's lifetime, while a tab strip's Run/Send button is shared and
// reassigned across tabs.
//
// DOM-free (a `.ts` under `view/` must be — see CLAUDE.md), so the strip is typed
// structurally rather than imported from tab-strip.js.

export interface StartOptions {
  /**
   * Keep the tab's current outcome on screen while the run is in flight. The
   * Record Detail's SAVE is a run against the record the user is looking at —
   * clearing it would blank the page for the round trip. A LOAD passes nothing,
   * so the previous record goes the moment another is asked for.
   */
  keepOutcome?: boolean;
}

/** The slice of tab-strip.js's API a run needs. */
export interface RunnableStrip<T> {
  setActiveOpId(opId: string | null, tab?: T): void;
  findByOpId(opId: string | undefined): T | undefined;
  getRunningOpIds(): string[];
  clearAllOpIds(): void;
  settleRun(tab: T, results: unknown, error?: unknown): void;
}

export interface TabRunnerCtx<T> {
  /** A getter: the strip is built in the binding's `attach`, after this runner. */
  tabs: () => RunnableStrip<T>;
  vscode: { postMessage: (msg: unknown) => void };
  /** opId namespace (`rest`, `apex`, …) — must stay disjoint from every other one. */
  prefix: string;
}

export interface ClaimedRun<T, P> {
  tab: T;
  opId: string;
  /** What `start` was given — the request AS SENT, not as the form holds it now. */
  payload: P | undefined;
}

export function createTabRunner<T, P>(ctx: TabRunnerCtx<T>) {
  let seq = 0;
  const pending = new Map<string, P>();
  const post = (type: string, opId: string) => ctx.vscode.postMessage({ type, opId });

  /**
   * Start a run on behalf of `tab` (captured by the caller at click time — a
   * sensitive-org confirm in between is asynchronous). Clears the tab's previous
   * outcome, marks its pill running, then lets `send` post the request.
   */
  function start(tab: T, payload: P, send: (opId: string) => void, opts?: StartOptions): string {
    const opId = `${ctx.prefix}-${++seq}`;
    const tabs = ctx.tabs();
    if (!opts?.keepOutcome) tabs.settleRun(tab, null, null);
    pending.set(opId, payload);
    // Through the strip, not `tab.opId =`, so the pill repaints with its ⋯ now.
    tabs.setActiveOpId(opId, tab);
    send(opId);
    // Lets the host count this as busy, so switching orgs mid-run warns first.
    post('operationStarted', opId);
    return opId;
  }

  /** Abandon one run. Its tab's opId is the caller's to clear (or already gone). */
  function stop(opId: string | null | undefined) {
    if (!opId) return;
    pending.delete(opId);
    post('cancelOperation', opId);
    post('operationEnded', opId);
  }

  /** Abandon every run — org edges and `cancelAllOperations`. */
  function stopAll() {
    const tabs = ctx.tabs();
    for (const opId of tabs.getRunningOpIds()) stop(opId);
    tabs.clearAllOpIds();
  }

  /**
   * The tab a reply belongs to, or null when it has none — closed, cancelled or
   * superseded — in which case the reply is dropped. The operation is ended
   * either way, so the host does not stay busy over a reply nobody wanted.
   */
  function claim(msg: { data?: { opId?: string } }): ClaimedRun<T, P> | null {
    const opId = msg.data?.opId;
    const tab = ctx.tabs().findByOpId(opId);
    if (opId) post('operationEnded', opId);
    if (!tab || !opId) return null;
    const payload = pending.get(opId);
    pending.delete(opId);
    return { tab, opId, payload };
  }

  return { start, stop, stopAll, claim };
}

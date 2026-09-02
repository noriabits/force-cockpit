import { ConnectionManager } from '../../salesforce/connection';
import { OrgDetails } from '../../utils/sfCli';

/**
 * Environment dependencies for {@link OrgConnectionController}. All `vscode` and
 * filesystem access is injected so the controller's state machine can be unit-tested
 * without a real org, panel, or window.
 */
export interface OrgConnectionDeps {
  connectionManager: ConnectionManager;
  /** Reads `target-org` from .sf/config.json. Returns undefined when unset; throws on read/parse error. */
  readTargetOrg(): string | undefined;
  getOrgDetails(target: string): Promise<OrgDetails>;
  refreshOrgToken(target: string): Promise<void>;
  guardBusy(action: string): Promise<boolean>;
  notifyConnecting(target: string): void;
  showWarning(msg: string): void;
  showInfo(msg: string): void;
  log(msg: string): void;
  /** Retry backoff delays between connection attempts. Default [2000, 4000, 8000]. Injectable for fast tests. */
  retryDelaysMs?: number[];
  /** Debounce window for {@link OrgConnectionController.scheduleConnect}. Default 300ms. */
  debounceMs?: number;
}

/**
 * What {@link OrgConnectionController.readTarget} found in `.sf/config.json`:
 * the org to connect to, no default org at all, or a read that failed and has
 * already been reported to the user.
 */
type TargetResolution = { kind: 'target'; target: string } | { kind: 'none' } | { kind: 'stop' };

/** `Error.message` when there is one, else the value stringified. Both user-facing failures need it. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Owns the `.sf/config.json` → org-connection state machine: version-guarded connects
 * (the `connectVersion` counter is checked after every `await`), a debounced
 * `scheduleConnect`, and a retry loop with exponential backoff racing a token refresh.
 *
 * Ported verbatim from the original inline `connectFromConfig` closures in extension.ts —
 * the version checks after every `await` are load-bearing for overlapping invocations.
 */
export class OrgConnectionController {
  private connectVersion = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly retryDelaysMs: number[];
  private readonly debounceMs: number;

  constructor(private readonly deps: OrgConnectionDeps) {
    this.retryDelaysMs = deps.retryDelaysMs ?? [2000, 4000, 8000];
    this.debounceMs = deps.debounceMs ?? 300;
  }

  /**
   * Single connection attempt — re-reads credentials fresh each time.
   * Returns true on success, throws on failure; returns false if version-stale.
   */
  private async attemptConnect(target: string, myVersion: number): Promise<boolean> {
    if (myVersion !== this.connectVersion) return false;
    const details = await this.deps.getOrgDetails(target);
    if (myVersion !== this.connectVersion) return false;
    await this.deps.connectionManager.connect(details);
    return true;
  }

  /**
   * Reads the org the config file is asking for. SYNCHRONOUS, deliberately:
   * an `await` here would add a microtask tick to the happy path before
   * `getOrgDetails` is reached, and the version-race test pins that scheduling
   * (it starts a second `connectFromConfig` after a single tick and expects the
   * FIRST to already own the in-flight `getOrgDetails`). The no-target branch
   * does need to await, so it lives in its own method off the `none` arm rather
   * than making this one async.
   *
   * `stop` means the read failed and has already been reported; `none` means
   * the file names no default org.
   */
  private readTarget(force: boolean): TargetResolution {
    try {
      const target = this.deps.readTargetOrg();
      return target ? { kind: 'target', target } : { kind: 'none' };
    } catch (err) {
      // A forced refresh is user-initiated, so the read failure is reported to
      // them and swallowed. An automatic one is silent: it propagates to
      // connectFromConfig's catch, which only logs.
      if (!force) throw err;
      this.deps.showWarning(`Force Cockpit: could not read .sf/config.json. ${errText(err)}`);
      return { kind: 'stop' };
    }
  }

  /**
   * The config file names no default org: tear down a live connection (asking
   * first, since work may be in flight), or say so when the user forced this.
   */
  private async handleTargetRemoved(force: boolean, myVersion: number): Promise<void> {
    if (this.deps.connectionManager.isConnected) {
      if (!(await this.deps.guardBusy('The default org was removed.'))) return;
      if (myVersion !== this.connectVersion) return;
      this.deps.connectionManager.disconnect();
    } else if (force) {
      this.deps.showInfo('Force Cockpit: no default org set in .sf/config.json.');
    }
  }

  /**
   * Retries up to `retryDelaysMs.length` times. Each retry re-reads credentials
   * from disk (picking up any token the SF CLI wrote) while concurrently
   * triggering an SF CLI token refresh, so the next attempt has a fresh access
   * token. Returns silently when superseded — the version check after the await
   * is load-bearing for overlapping invocations.
   */
  private async connectWithRetry(target: string, myVersion: number): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt++) {
      try {
        if (!(await this.attemptConnect(target, myVersion))) return; // stale — exit silently
        return; // success — connectionChanged event updates the panel
      } catch (err) {
        if (myVersion !== this.connectVersion) return;
        lastErr = err;
        if (attempt < this.retryDelaysMs.length) {
          // Refresh token and wait concurrently before retrying
          await Promise.all([
            new Promise<void>((resolve) => setTimeout(resolve, this.retryDelaysMs[attempt])),
            this.deps.refreshOrgToken(target),
          ]);
        }
      }
    }
    // All attempts failed
    this.deps.showWarning(
      `Force Cockpit: failed to connect to org "${target}". ${errText(lastErr)}`,
    );
  }

  async connectFromConfig(opts: { force?: boolean } = {}): Promise<void> {
    const { connectionManager } = this.deps;
    const force = opts.force === true;
    const myVersion = ++this.connectVersion;
    try {
      const resolved = this.readTarget(force);
      if (resolved.kind === 'stop') return;
      if (resolved.kind === 'none') return await this.handleTargetRemoved(force, myVersion);
      const { target } = resolved;

      // Skip if already connected to the same org (unless forcing a refresh)
      const current = connectionManager.getCurrentOrg();
      if (!force && (current?.alias === target || current?.username === target)) return;

      const guardMessage = force ? 'Refreshing the org connection.' : 'The default org changed.';
      if (!(await this.deps.guardBusy(guardMessage))) return;
      if (myVersion !== this.connectVersion) return;

      if (connectionManager.isConnected) connectionManager.disconnect();

      // Notify the webview that a connection attempt is starting (shows spinner)
      this.deps.notifyConnecting(target);

      await this.connectWithRetry(target, myVersion);
    } catch (err) {
      this.deps.log(`[Error] connectFromConfig failed: ${String(err)}`);
    }
  }

  /** Debounced connect — coalesces rapid watcher events into a single attempt. */
  scheduleConnect(): void {
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.connectFromConfig(), this.debounceMs);
  }

  /** Called when .sf/config.json is deleted — disconnects immediately if connected. */
  handleConfigDeleted(): void {
    if (this.deps.connectionManager.isConnected) this.deps.connectionManager.disconnect();
  }

  dispose(): void {
    clearTimeout(this.debounceTimer);
  }
}

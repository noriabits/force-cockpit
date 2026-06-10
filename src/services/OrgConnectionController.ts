import { ConnectionManager } from '../salesforce/connection';
import { OrgDetails } from '../utils/sfCli';

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

  async connectFromConfig(opts: { force?: boolean } = {}): Promise<void> {
    const { connectionManager } = this.deps;
    const force = opts.force === true;
    const myVersion = ++this.connectVersion;
    try {
      let target: string | undefined;
      try {
        target = this.deps.readTargetOrg();
      } catch (err) {
        if (force) {
          this.deps.showWarning(
            `Force Cockpit: could not read .sf/config.json. ${err instanceof Error ? err.message : String(err)}`,
          );
          return;
        }
        throw err;
      }

      if (!target) {
        if (connectionManager.isConnected) {
          if (!(await this.deps.guardBusy('The default org was removed.'))) return;
          if (myVersion !== this.connectVersion) return;
          connectionManager.disconnect();
        } else if (force) {
          this.deps.showInfo('Force Cockpit: no default org set in .sf/config.json.');
        }
        return;
      }

      // Skip if already connected to the same org (unless forcing a refresh)
      const current = connectionManager.getCurrentOrg();
      if (!force && (current?.alias === target || current?.username === target)) return;

      const guardMessage = force ? 'Refreshing the org connection.' : 'The default org changed.';
      if (!(await this.deps.guardBusy(guardMessage))) return;
      if (myVersion !== this.connectVersion) return;

      if (connectionManager.isConnected) connectionManager.disconnect();

      // Notify the webview that a connection attempt is starting (shows spinner)
      this.deps.notifyConnecting(target);

      // Retry up to retryDelaysMs.length times. On each retry: re-read credentials from disk
      // (picks up any token the SF CLI wrote) and concurrently trigger an SF CLI token refresh
      // so the next attempt has a fresh access token.
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
        `Force Cockpit: failed to connect to org "${target}". ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
      );
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

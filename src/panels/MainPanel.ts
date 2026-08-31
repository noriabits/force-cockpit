import * as vscode from 'vscode';
import * as path from 'path';
import type { ConnectionManager, ConnectionChangedEvent } from '../salesforce/connection';
import { RestCallService } from '../services/rest/RestCallService';
import { RestCallStateStore } from '../services/rest/RestCallStateStore';
import type { FeatureModule, FeatureModuleFactory } from '../features/FeatureModule';
import type { CockpitConfig } from '../utils/config';
import { WebviewAssets } from './WebviewAssets';
import { OperationRegistry } from './OperationRegistry';
import { MessageRouter } from './MessageRouter';
import type { HostMessage, WebviewMessage } from '../shared/protocol';
import type { FeatureContext } from '../features/FeatureContext';

export class MainPanel {
  public static currentPanel: MainPanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _features: FeatureModule[];
  private readonly _operations = new OperationRegistry();
  private readonly _assets: WebviewAssets;
  private readonly _router: MessageRouter;
  private _disposables: vscode.Disposable[] = [];

  // Limits cache (reuse within 60 seconds)
  private _limitsCache: { data: unknown; ts: number } | null = null;

  get hasActiveOperations(): boolean {
    return this._operations.hasActive;
  }

  cancelAllOps(): void {
    this._operations.cancelAll();
    this.postWebviewMessage({ type: 'cancelAllOperations' });
  }

  notifyConnecting(orgName: string): void {
    // `{ type, data }` like every other host->webview message. This one used to
    // carry `orgName` at the top level — the lone exception, which only stayed
    // that way because the post was untyped.
    this.postWebviewMessage({ type: 'orgConnecting', data: { orgName } });
  }

  notifyLogsChanged(): void {
    this.postWebviewMessage({ type: 'executionLogsChanged' });
  }

  /** Generic post hook used by background features (e.g. monitoring refresher). */
  /**
   * The ONE place this class talks to the webview. Everything internal goes
   * through it so the `type` is checked against `HostToWebviewType` — several
   * posts used to call `webview.postMessage` directly, which type-checks
   * nothing at the call site even though the names are in the union.
   */
  postWebviewMessage(message: HostMessage): void {
    // eslint-disable-next-line no-restricted-syntax -- the chokepoint itself
    this._panel.webview.postMessage(message);
  }

  /**
   * Re-apply the panel title and re-send org info after a live config.yaml
   * reload — so the sensitive-org banner reflects a changed
   * `protectedSandboxes` without a window reload.
   *
   * Takes no config argument: the panel reads it through
   * `featureCtx.getConfig()`, which extension.ts reassigns on reload, so there
   * is nothing left to hand over. It used to hold a snapshot that only this
   * call kept in step — the exact staleness the ctx getter exists to remove.
   */
  refreshForConfigChange(): void {
    this._panel.title = 'Force Cockpit';
    void this._sendOrgInfo();
  }

  /**
   * `featureCtx` carries the ConnectionManager, DescribeService, output channel
   * and config getter that used to be four separate parameters — they are all
   * shared singletons built once in extension.ts, and every feature factory
   * needs them anyway.
   */
  static createOrShow(
    context: vscode.ExtensionContext,
    featureCtx: FeatureContext,
    featureFactories: FeatureModuleFactory[],
  ): MainPanel {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (MainPanel.currentPanel) {
      MainPanel.currentPanel._panel.reveal(column);
      return MainPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      'forceCockpit',
      'Force Cockpit',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.file(path.join(context.extensionPath, 'media')),
          vscode.Uri.file(path.join(context.extensionPath, 'webviews')),
          vscode.Uri.file(path.join(context.extensionPath, 'dist', 'features')),
          vscode.Uri.file(path.join(context.extensionPath, 'dist', 'vendor')),
          vscode.Uri.file(path.join(context.extensionPath, 'dist', 'webview')),
        ],
      },
    );

    MainPanel.currentPanel = new MainPanel(panel, context, featureCtx, featureFactories);
    return MainPanel.currentPanel;
  }

  private readonly connectionManager: ConnectionManager;
  private readonly outputChannel?: vscode.OutputChannel;
  /** Live, not a snapshot — extension.ts reassigns behind it on a config reload. */
  private readonly getConfig: () => CockpitConfig;

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    featureCtx: FeatureContext,
    featureFactories: FeatureModuleFactory[],
  ) {
    const { connectionManager, describeService } = featureCtx;
    this.connectionManager = connectionManager;
    this.outputChannel = featureCtx.outputChannel;
    this.getConfig = featureCtx.getConfig;
    this._panel = panel;
    this._features = featureFactories.map((factory) => factory(featureCtx));
    this._assets = new WebviewAssets(context, panel.webview, this._features);
    this._router = new MessageRouter({
      webview: panel.webview,
      connectionManager,
      restCallService: new RestCallService(connectionManager),
      restCallStateStore: new RestCallStateStore(context.workspaceState),
      describeService,
      features: this._features,
      operations: this._operations,
      onReady: () => this._sendOrgInfo(),
    });

    void this._update().catch((err: unknown) => {
      this.outputChannel?.appendLine(`[Error] Panel init failed: ${String(err)}`);
    });
    this._setupLifecycleListeners();
    this._setupMessageListener();
    this._setupConnectionListener();
  }

  private _setupLifecycleListeners(): void {
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.onDidChangeViewState(
      () => {
        if (this._panel.visible) {
          void this._sendOrgInfo();
        }
        // Notify features about panel visibility (used by monitoring to pause auto-refresh)
        this.postWebviewMessage({
          type: 'panelVisibilityChanged',
          data: { visible: this._panel.visible },
        });
      },
      null,
      this._disposables,
    );
  }

  private _setupMessageListener(): void {
    this._panel.webview.onDidReceiveMessage(
      // Trust boundary: this arrives from the webview sandbox, so it is `unknown`
      // at runtime no matter what the contract says. The cast is where we accept
      // that. The contract is enforced where it can be — on the webview's send
      // side and on the host's route registration (`FeatureModule.routes`) —
      // and `handle` drops any type it does not recognise.
      (message: unknown) => this._router.handle(message as WebviewMessage),
      null,
      this._disposables,
    );
  }

  private _setupConnectionListener(): void {
    const onChanged = (event: ConnectionChangedEvent) => {
      this._limitsCache = null; // Invalidate on org change
      if (event.connected) {
        void this._sendOrgInfo();
      } else {
        this.postWebviewMessage({ type: 'orgDisconnected' });
      }
    };
    this.connectionManager.on('connectionChanged', onChanged);
    this._disposables.push({
      dispose: () => this.connectionManager.off('connectionChanged', onChanged),
    });
  }

  private async _sendOrgInfo(): Promise<void> {
    const org = this.connectionManager.getCurrentOrg();
    if (!org) {
      this.postWebviewMessage({ type: 'orgDisconnected' });
      return;
    }
    const orgDetails = await this.connectionManager.getOrganizationDetails();
    const isProduction = await this.connectionManager.isProductionOrg();
    const sandboxName = isProduction ? null : this.connectionManager.getSandboxName();
    const protectedSandboxes = this.getConfig().protectedSandboxes.map((s) => s.toLowerCase());
    const isProtectedOrg =
      !isProduction && protectedSandboxes.includes((sandboxName ?? '').toLowerCase());
    this.postWebviewMessage({
      type: 'orgConnected',
      data: { ...org, sandboxName, isProtectedOrg, instanceName: orgDetails.InstanceName },
    });
    void this._sendStorageLimits();
    void this._sendReleaseInfo();
  }

  private async _sendReleaseInfo(): Promise<void> {
    try {
      const release = await this.connectionManager.getReleaseInfo();
      this.postWebviewMessage({ type: 'releaseInfo', data: release });
    } catch (err) {
      this.outputChannel?.appendLine(`[Warn] Release info unavailable: ${String(err)}`);
    }
  }

  private async _sendStorageLimits(): Promise<void> {
    const now = Date.now();
    if (this._limitsCache && now - this._limitsCache.ts < 60_000) {
      this.postWebviewMessage({ type: 'storageLimits', data: this._limitsCache.data });
      return;
    }
    try {
      const limits = await this.connectionManager.getLimits();
      this._limitsCache = { data: limits, ts: now };
      this.postWebviewMessage({ type: 'storageLimits', data: limits });
    } catch (err) {
      this.outputChannel?.appendLine(`[Warn] Storage limits unavailable: ${String(err)}`);
    }
  }

  private async _update(): Promise<void> {
    this._panel.title = 'Force Cockpit';
    this._panel.webview.html = await this._assets.getHtml();
    // Org info is delivered in response to the webview's 'ready' message,
    // which fires after all scripts have initialized their message listeners.
  }

  dispose(): void {
    MainPanel.currentPanel = undefined;
    this._panel.dispose();
    for (const feature of this._features) feature.dispose?.();
    for (const d of this._disposables) d.dispose();
    this._disposables = [];
  }
}

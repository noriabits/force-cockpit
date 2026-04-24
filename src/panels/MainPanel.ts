import * as vscode from 'vscode';
import * as path from 'path';
import type { ConnectionManager, ConnectionChangedEvent } from '../salesforce/connection';
import { QueryService } from '../services/QueryService';
import type { FeatureModule, FeatureModuleFactory } from '../features/FeatureModule';
import type { CockpitConfig } from '../utils/config';
import { WebviewAssets } from './WebviewAssets';
import { OperationRegistry } from './OperationRegistry';
import { MessageRouter } from './MessageRouter';

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
    this._panel.webview.postMessage({ type: 'cancelAllOperations' });
  }

  notifyConnecting(orgName: string): void {
    this._panel.webview.postMessage({ type: 'orgConnecting', orgName });
  }

  notifyLogsChanged(): void {
    this._panel.webview.postMessage({ type: 'executionLogsChanged' });
  }

  updateConfig(config: CockpitConfig): void {
    this.config = config;
    this._panel.title = 'Force Cockpit';
    void this._sendOrgInfo();
  }

  static createOrShow(
    context: vscode.ExtensionContext,
    connectionManager: ConnectionManager,
    featureFactories: FeatureModuleFactory[],
    config: CockpitConfig,
    outputChannel?: vscode.OutputChannel,
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
        ],
      },
    );

    MainPanel.currentPanel = new MainPanel(
      panel,
      context,
      connectionManager,
      featureFactories,
      config,
      outputChannel,
    );
    return MainPanel.currentPanel;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly connectionManager: ConnectionManager,
    featureFactories: FeatureModuleFactory[],
    private config: CockpitConfig,
    private readonly outputChannel?: vscode.OutputChannel,
  ) {
    this._panel = panel;
    this._features = featureFactories.map((factory) => factory(connectionManager));
    this._assets = new WebviewAssets(context, panel.webview, this._features);
    this._router = new MessageRouter({
      webview: panel.webview,
      connectionManager,
      queryService: new QueryService(connectionManager),
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
        this._panel.webview.postMessage({
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
      (message: { type: string; [key: string]: unknown }) => this._router.handle(message),
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
        this._panel.webview.postMessage({ type: 'orgDisconnected' });
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
      this._panel.webview.postMessage({ type: 'orgDisconnected' });
      return;
    }
    const isProduction = await this.connectionManager.isProductionOrg();
    const sandboxName = isProduction ? null : this.connectionManager.getSandboxName();
    const protectedSandboxes = this.config.protectedSandboxes.map((s) => s.toLowerCase());
    const isProtectedOrg =
      !isProduction && protectedSandboxes.includes((sandboxName ?? '').toLowerCase());
    this._panel.webview.postMessage({
      type: 'orgConnected',
      data: { ...org, sandboxName, isProtectedOrg },
    });
    void this._sendStorageLimits();
  }

  private async _sendStorageLimits(): Promise<void> {
    const now = Date.now();
    if (this._limitsCache && now - this._limitsCache.ts < 60_000) {
      this._panel.webview.postMessage({ type: 'storageLimits', data: this._limitsCache.data });
      return;
    }
    try {
      const limits = await this.connectionManager.getLimits();
      this._limitsCache = { data: limits, ts: now };
      this._panel.webview.postMessage({ type: 'storageLimits', data: limits });
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
    for (const d of this._disposables) d.dispose();
    this._disposables = [];
  }
}

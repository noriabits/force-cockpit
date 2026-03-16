import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import type { ConnectionManager, ConnectionChangedEvent } from '../salesforce/connection';
import { QueryService } from '../services/QueryService';
import type { FeatureModule, FeatureModuleFactory } from '../features/FeatureModule';
import { buildRecordUrl } from '../utils/salesforceUrl';
import type { CockpitConfig } from '../utils/config';

function getNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

export class MainPanel {
  public static currentPanel: MainPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  // Core services
  private readonly queryService: QueryService;
  // Feature modules (loaded from registry)
  private readonly features: FeatureModule[];

  // Generic operation tracking
  private _activeTerminalOps = new Map<string, AbortController>();
  private _webviewBusyCount = 0;

  get hasActiveOperations(): boolean {
    return this._webviewBusyCount > 0;
  }

  cancelAllOps(): void {
    for (const ac of this._activeTerminalOps.values()) ac.abort();
    this._activeTerminalOps.clear();
    this._panel.webview.postMessage({ type: 'cancelAllOperations' });
  }

  notifyConnecting(orgName: string): void {
    this._panel.webview.postMessage({ type: 'orgConnecting', orgName });
  }

  updateConfig(config: CockpitConfig): void {
    this.config = config;
    this._panel.title = config.panelTitle;
    void this._sendOrgInfo();
  }

  static createOrShow(
    context: vscode.ExtensionContext,
    connectionManager: ConnectionManager,
    featureFactories: FeatureModuleFactory[],
    workspaceRoot: string = '',
    config: CockpitConfig,
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
          vscode.Uri.file(workspaceRoot),
        ],
      },
    );

    MainPanel.currentPanel = new MainPanel(
      panel,
      context,
      connectionManager,
      featureFactories,
      workspaceRoot,
      config,
    );
    return MainPanel.currentPanel;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly connectionManager: ConnectionManager,
    featureFactories: FeatureModuleFactory[],
    private readonly workspaceRoot: string = '',
    private config: CockpitConfig,
  ) {
    this._panel = panel;
    this.queryService = new QueryService(connectionManager);
    this.features = featureFactories.map((factory) => factory(connectionManager));

    this._update();
    this._setupLifecycleListeners();
    this._setupMessageHandlers();
    this._setupConnectionListeners();
  }

  private _setupLifecycleListeners(): void {
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.onDidChangeViewState(
      () => {
        if (this._panel.visible) {
          void this._sendOrgInfo();
        }
      },
      null,
      this._disposables,
    );
  }

  private _setupMessageHandlers(): void {
    // Route messages from webview to services
    this._panel.webview.onDidReceiveMessage(
      async (message: { type: string; [key: string]: unknown }) => {
        switch (message.type) {
          case 'refresh':
            await this._sendOrgInfo();
            break;
          case 'query':
            await this._route(
              () => this.queryService.runQuery(message.soql as string),
              'queryResult',
              'queryError',
            );
            break;
          case 'operationStarted':
            this._webviewBusyCount = (message.count as number) ?? 1;
            break;
          case 'operationEnded':
            this._webviewBusyCount = (message.count as number) ?? 0;
            break;
          case 'cancelOperation': {
            const opId = message.opId as string;
            const ac = this._activeTerminalOps.get(opId);
            if (ac) {
              ac.abort();
              this._activeTerminalOps.delete(opId);
            }
            break;
          }
          case 'openRecord': {
            const org = this.connectionManager.getCurrentOrg();
            if (org) {
              const url = buildRecordUrl(org, message.recordId as string);
              await vscode.env.openExternal(vscode.Uri.parse(url));
            }
            return;
          }
          case 'openInBrowser':
            try {
              await vscode.commands.executeCommand('forceCockpit.openInBrowser');
            } finally {
              this._panel.webview.postMessage({ type: 'openInBrowserDone' });
            }
            return;
          case 'confirmAction': {
            const answer = await vscode.window.showWarningMessage(
              message.prompt as string,
              { modal: true },
              'Execute',
            );
            this._panel.webview.postMessage({
              type: 'confirmActionResult',
              data: { confirmed: answer === 'Execute', requestId: message.requestId },
            });
            return;
          }
          default: {
            // Dispatch to feature module routes
            for (const feature of this.features) {
              const route = feature.routes[message.type];
              if (route) {
                const opId = message.opId as string | undefined;
                const ac = new AbortController();
                if (opId) this._activeTerminalOps.set(opId, ac);

                await this._route(
                  () => route.handler(message, opId ? ac.signal : undefined),
                  route.successType,
                  route.errorType,
                  message as Record<string, unknown>, // includes opId — echoed in result
                );

                if (opId) this._activeTerminalOps.delete(opId);
                return;
              }
            }
            break;
          }
        }
      },
      null,
      this._disposables,
    );
  }

  private _setupConnectionListeners(): void {
    // Forward connection changes to webview
    const onChanged = (event: ConnectionChangedEvent) => {
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

    // If already connected when the panel is first opened, send org info immediately.
    // (The connectionChanged event was emitted before this panel existed.)
    if (this.connectionManager.isConnected) {
      void this._sendOrgInfo();
    }
  }

  /** Route a service call: on success post successType, on error post errorType.
   *  context is merged into BOTH the success and error payloads (so opId echoes back). */
  private async _route<T>(
    action: () => Promise<T>,
    successType: string,
    errorType: string,
    context: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      const data = await action();
      const dataObj =
        typeof data === 'object' && data !== null
          ? { ...(data as Record<string, unknown>), ...context }
          : { result: data, ...context };
      this._panel.webview.postMessage({ type: successType, data: dataObj });
    } catch (err) {
      this._panel.webview.postMessage({
        type: errorType,
        data: { ...context, message: (err as Error).message },
      });
    }
  }

  private async _sendOrgInfo(): Promise<void> {
    const org = this.connectionManager.getCurrentOrg();
    if (org) {
      const isProduction = await this.connectionManager.isProductionOrg();
      const sandboxName = isProduction ? null : this.connectionManager.getSandboxName();
      const protectedSandboxes = this.config.protectedSandboxes.map((s) => s.toLowerCase());
      const isProtectedOrg =
        !isProduction && protectedSandboxes.includes((sandboxName ?? '').toLowerCase());
      this._panel.webview.postMessage({
        type: 'orgConnected',
        data: { ...org, sandboxName, isProtectedOrg },
      });
      this._sendStorageLimits();
    } else {
      this._panel.webview.postMessage({ type: 'orgDisconnected' });
    }
  }

  private async _sendStorageLimits(): Promise<void> {
    try {
      const limits = await this.connectionManager.getLimits();
      this._panel.webview.postMessage({ type: 'storageLimits', data: limits });
    } catch {
      // Storage limits are non-critical — silently ignore failures
    }
  }

  private _update(): void {
    this._panel.title = this.config.panelTitle;
    this._panel.webview.html = this._getHtml();
    // Give the webview a tick to initialize its message listener before sending org state
    setTimeout(() => void this._sendOrgInfo(), 100);
  }

  private _resolveLogoUri(webview: vscode.Webview): vscode.Uri {
    const resolvedLogoPath = this.config.logoPath
      ? path.join(this.workspaceRoot, this.config.logoPath)
      : path.join(this.context.extensionPath, 'media', 'fc-logo.png');
    return webview.asWebviewUri(vscode.Uri.file(resolvedLogoPath));
  }

  private _collectFeatureAssets(
    nonce: string,
  ): { tabFragments: Record<string, string>; linkTags: string[]; scriptTags: string[] } {
    const webview = this._panel.webview;
    const tabFragments: Record<string, string> = {};
    const linkTags: string[] = [];
    const scriptTags: string[] = [];

    for (const feature of this.features) {
      const absHtml = path.join(this.context.extensionPath, feature.htmlPath);
      const absJs = path.join(this.context.extensionPath, feature.jsPath);
      const absCss = path.join(this.context.extensionPath, feature.cssPath);

      tabFragments[feature.tab] =
        (tabFragments[feature.tab] ?? '') + fs.readFileSync(absHtml, 'utf8');

      const cssUri = webview.asWebviewUri(vscode.Uri.file(absCss));
      linkTags.push(`<link rel="stylesheet" href="${cssUri}">`);

      // Labels script (defer) must come before view script so the global is ready
      if (feature.labelsPath) {
        const absLabels = path.join(this.context.extensionPath, feature.labelsPath);
        const labelsUri = webview.asWebviewUri(vscode.Uri.file(absLabels));
        scriptTags.push(`<script nonce="${nonce}" src="${labelsUri}" defer></script>`);
      }

      const featureJsUri = webview.asWebviewUri(vscode.Uri.file(absJs));
      scriptTags.push(`<script nonce="${nonce}" src="${featureJsUri}" defer></script>`);
    }

    return { tabFragments, linkTags, scriptTags };
  }

  private _getHtml(): string {
    const webview = this._panel.webview;
    const nonce = getNonce();

    const htmlPath = path.join(this.context.extensionPath, 'webviews', 'main.html');
    const cssUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, 'media', 'main.css')),
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, 'media', 'main.js')),
    );
    const chartJsUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, 'dist', 'vendor', 'chart.umd.js')),
    );
    const logoUri = this._resolveLogoUri(webview);
    const panelTitle = this.config.panelTitle;

    const { tabFragments, linkTags, scriptTags } = this._collectFeatureAssets(nonce);

    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html
      .replace(/\$\{nonce\}/g, nonce)
      .replace(/\$\{cssUri\}/g, cssUri.toString())
      .replace(/\$\{jsUri\}/g, jsUri.toString())
      .replace(/\$\{chartJsUri\}/g, chartJsUri.toString())
      .replace(/\$\{cspSource\}/g, webview.cspSource)
      .replace(/\$\{logoUri\}/g, logoUri.toString())
      .replace(/\$\{panelTitle\}/g, panelTitle);

    // Inject feature HTML into tab container placeholders
    for (const [tab, fragments] of Object.entries(tabFragments)) {
      html = html.replace(`<!-- features:${tab} -->`, fragments);
    }

    // Inject feature CSS link tags and JS script tags
    html = html.replace('</head>', linkTags.join('\n') + '\n</head>');
    html = html.replace('</body>', scriptTags.join('\n') + '\n</body>');

    return html;
  }

  dispose(): void {
    MainPanel.currentPanel = undefined;
    this._panel.dispose();
    for (const d of this._disposables) {
      d.dispose();
    }
    this._disposables = [];
  }
}

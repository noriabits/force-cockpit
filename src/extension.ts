import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ConnectionManager, ConnectionChangedEvent } from './salesforce/connection';
import { MainPanel } from './panels/MainPanel';
import { getOrgDetails, refreshOrgToken } from './utils/sfCli';
import { buildOrgUrl } from './utils/salesforceUrl';
import { featureRegistry } from './features/registry';
import { createYamlScriptsFeature } from './features/utils/yaml-scripts/index';
import { createExecutionLogsFeature } from './features/utils/execution-logs/index';
import { createMonitoringDashboardFeature } from './features/monitoring/monitoring-dashboard/index';
import { Logger } from '@salesforce/core';
import { loadConfig } from './utils/config';

export function activate(context: vscode.ExtensionContext): void {
  // Prevent @salesforce/core from creating a pino worker-thread transport.
  // The transport uses a relative file path that cannot be resolved after esbuild bundling.
  // Belt: env vars disable file logging for any Logger instance (including child loggers).
  // Suspenders: pre-initialise the root logger singleton in memory-only mode so the
  //             transport code path is never reached when StateAggregator calls Logger.root().
  process.env['SFDX_DISABLE_LOG_FILE'] = 'true';
  process.env['SF_DISABLE_LOG_FILE'] = 'true';
  try {
    new Logger({ name: Logger.ROOT_NAME, useMemoryLogger: true });
  } catch {
    // Root logger already initialized — no action needed
  }

  const outputChannel = vscode.window.createOutputChannel('Force Cockpit');
  context.subscriptions.push(outputChannel);

  const connectionManager = new ConnectionManager();

  // Status bar item: shows Sandbox / Production indicator
  const orgTypeItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  orgTypeItem.tooltip = 'Force Cockpit: org type';
  context.subscriptions.push(orgTypeItem);
  connectionManager.on('connectionChanged', (event: ConnectionChangedEvent) => {
    if (!event.connected) {
      orgTypeItem.hide();
      return;
    }
    void (async () => {
      try {
        const isProduction = await connectionManager.isProductionOrg();
        if (isProduction) {
          orgTypeItem.text = '$(circle-filled) Production';
          orgTypeItem.color = new vscode.ThemeColor('errorForeground');
          orgTypeItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        } else {
          orgTypeItem.text = '$(circle-filled) Sandbox';
          orgTypeItem.color = new vscode.ThemeColor('testing.iconPassed');
          orgTypeItem.backgroundColor = undefined;
        }
        orgTypeItem.show();
      } catch {
        orgTypeItem.hide();
      }
    })();
  });

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const builtInPath = path.join(context.extensionPath, 'force-cockpit');
  const userBasePath =
    vscode.workspace.getConfiguration('forceCockpit').get<string>('cockpitPath') ||
    path.join(workspaceRoot, 'force-cockpit');

  let cockpitConfig = loadConfig(context.extensionPath, userBasePath);
  connectionManager.setApiVersion(cockpitConfig.apiVersion);

  // Auto-create user folders on first run (only when we have an absolute path)
  if (path.isAbsolute(userBasePath)) {
    fs.mkdirSync(path.join(userBasePath, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(userBasePath, 'monitoring'), { recursive: true });
    fs.mkdirSync(path.join(userBasePath, 'private', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(userBasePath, 'private', 'monitoring'), { recursive: true });
    // Drop a .gitignore inside private/ so its contents are never committed
    const privateGitignore = path.join(userBasePath, 'private', '.gitignore');
    if (!fs.existsSync(privateGitignore)) {
      try {
        fs.writeFileSync(privateGitignore, '*\n', 'utf8');
      } catch {
        // Silent — gitignore management is best-effort
      }
    }
  }

  // Watch config.yaml for live changes
  function reloadConfig(): void {
    cockpitConfig = loadConfig(context.extensionPath, userBasePath);
    connectionManager.setApiVersion(cockpitConfig.apiVersion);
    MainPanel.currentPanel?.updateConfig(cockpitConfig);
  }
  if (workspaceRoot) {
    const configWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(userBasePath, 'config.yaml'),
    );
    configWatcher.onDidChange(reloadConfig);
    configWatcher.onDidCreate(reloadConfig);
    configWatcher.onDidDelete(reloadConfig);
    context.subscriptions.push(configWatcher);
  }

  const allFeatures = [
    ...featureRegistry,
    createYamlScriptsFeature({
      builtInPath: path.join(builtInPath, 'scripts'),
      userPath: path.join(userBasePath, 'scripts'),
      privatePath: path.join(userBasePath, 'private', 'scripts'),
      workspaceRoot,
      workspaceState: context.workspaceState,
    }),
    createMonitoringDashboardFeature({
      builtInPath: path.join(builtInPath, 'monitoring'),
      userPath: path.join(userBasePath, 'monitoring'),
      privatePath: path.join(userBasePath, 'private', 'monitoring'),
      workspaceState: context.workspaceState,
    }),
    createExecutionLogsFeature(path.join(userBasePath, 'logs')),
  ];

  // Watch for new/deleted execution logs and notify the webview
  if (path.isAbsolute(userBasePath)) {
    const logsWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(userBasePath, 'logs/*.log'),
    );
    const notifyLogs = () => MainPanel.currentPanel?.notifyLogsChanged();
    logsWatcher.onDidCreate(notifyLogs);
    logsWatcher.onDidDelete(notifyLogs);
    context.subscriptions.push(logsWatcher);
  }

  // Guard: if any operation is running, warn before switching/disconnecting
  async function guardBusy(action: string): Promise<boolean> {
    if (!MainPanel.currentPanel?.hasActiveOperations) return true;
    const answer = await vscode.window.showWarningMessage(
      `⚠️ An operation is in progress. ${action}`,
      { modal: true },
      'Proceed anyway',
    );
    if (answer !== 'Proceed anyway') return false;
    MainPanel.currentPanel.cancelAllOps();
    return true;
  }

  // --- Sidebar view (launcher only) ---
  const emptyProvider: vscode.TreeDataProvider<never> = {
    getTreeItem: (e) => e,
    getChildren: () => [],
  };
  const sidebarView = vscode.window.createTreeView('forceCockpit.panel', {
    treeDataProvider: emptyProvider,
  });
  sidebarView.title = ` v${context.extension.packageJSON.version}`;
  sidebarView.onDidChangeVisibility(({ visible }) => {
    if (visible)
      MainPanel.createOrShow(context, connectionManager, allFeatures, cockpitConfig, outputChannel);
  });
  context.subscriptions.push(sidebarView);

  // --- Commands ---
  context.subscriptions.push(
    vscode.commands.registerCommand('forceCockpit.openPanel', () => {
      MainPanel.createOrShow(context, connectionManager, allFeatures, cockpitConfig, outputChannel);
    }),

    vscode.commands.registerCommand('forceCockpit.openInBrowser', async () => {
      const org = connectionManager.getCurrentOrg();
      if (!org) {
        vscode.window.showWarningMessage('No org connected.');
        return;
      }
      const url = buildOrgUrl(org);
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }),
  );

  // --- Watch .sf/config.json for target-org changes ---
  if (workspaceRoot) {
    const sfConfigPath = path.join(workspaceRoot, '.sf', 'config.json');
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let connectVersion = 0;

    // Single connection attempt — re-reads credentials fresh each time.
    // Returns true on success, throws on failure (version-stale returns false).
    async function attemptConnect(target: string, myVersion: number): Promise<boolean> {
      if (myVersion !== connectVersion) return false;
      const details = await getOrgDetails(target);
      if (myVersion !== connectVersion) return false;
      await connectionManager.connect(details);
      return true;
    }

    async function connectFromConfig(): Promise<void> {
      const myVersion = ++connectVersion;
      try {
        const raw = fs.readFileSync(sfConfigPath, 'utf8');
        const config = JSON.parse(raw) as Record<string, string>;
        const target = config['target-org'];

        if (!target) {
          if (connectionManager.isConnected) {
            if (!(await guardBusy('The default org was removed.'))) return;
            if (myVersion !== connectVersion) return;
            connectionManager.disconnect();
          }
          return;
        }

        // Skip if already connected to the same org
        const current = connectionManager.getCurrentOrg();
        if (current?.alias === target || current?.username === target) return;

        if (!(await guardBusy('The default org changed.'))) return;
        if (myVersion !== connectVersion) return;

        connectionManager.disconnect();

        // Notify the webview that a connection attempt is starting (shows spinner)
        MainPanel.currentPanel?.notifyConnecting(target);

        // Retry up to 3 times. On each retry: re-read credentials from disk (picks up any
        // token the SF CLI wrote) and concurrently trigger an SF CLI token refresh so the
        // next attempt has a fresh access token.
        const retryDelaysMs = [2000, 4000, 8000];
        let lastErr: unknown;
        for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
          try {
            if (!(await attemptConnect(target, myVersion))) return; // stale — exit silently
            return; // success — connectionChanged event updates the panel
          } catch (err) {
            if (myVersion !== connectVersion) return;
            lastErr = err;
            if (attempt < retryDelaysMs.length) {
              // Refresh token and wait concurrently before retrying
              await Promise.all([
                new Promise<void>((resolve) => setTimeout(resolve, retryDelaysMs[attempt])),
                refreshOrgToken(target),
              ]);
            }
          }
        }
        // All attempts failed
        vscode.window.showWarningMessage(
          `Force Cockpit: failed to connect to org "${target}". ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
        );
      } catch (err) {
        outputChannel.appendLine(`[Error] connectFromConfig failed: ${String(err)}`);
      }
    }

    function scheduleConnect(): void {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => void connectFromConfig(), 300);
    }

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspaceRoot, '.sf/config.json'),
    );
    watcher.onDidChange(scheduleConnect);
    watcher.onDidCreate(scheduleConnect);
    watcher.onDidDelete(() => {
      if (connectionManager.isConnected) connectionManager.disconnect();
    });
    context.subscriptions.push(watcher);

    // Auto-connect on activation — reuses connectFromConfig() with retry and race-guards
    void connectFromConfig();
  }
}

export function deactivate(): void {
  // Nothing to clean up — subscriptions handle it
}

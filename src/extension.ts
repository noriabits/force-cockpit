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
import { createMonitoringDashboardFeature } from './features/monitoring/dashboard/index';
import { Logger } from '@salesforce/core';
import { loadConfig } from './utils/config';
import { ensureUserFolders } from './utils/workspaceSetup';
import { setupOrgTypeStatusBar } from './ui/orgTypeStatusBar';
import { OrgConnectionController } from './services/OrgConnectionController';
import { DescribeService } from './services/DescribeService';
import { DescribeDiskCache } from './services/DescribeDiskCache';

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

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const builtInPath = path.join(context.extensionPath, 'force-cockpit');
  const userBasePath =
    vscode.workspace.getConfiguration('forceCockpit').get<string>('cockpitPath') ||
    path.join(workspaceRoot, 'force-cockpit');

  let cockpitConfig = loadConfig(context.extensionPath, userBasePath);
  connectionManager.setApiVersion(cockpitConfig.apiVersion);

  // Persistent, per-workspace describe cache shared by Quick Query autocomplete and
  // AI scripts. The disk layer survives reloads; each consumer keeps a cheap in-memory
  // map on top. Cleared on manual org refresh so schema is re-pulled on demand.
  const describeDiskCache = new DescribeDiskCache(path.join(userBasePath, '.describe-cache'));
  const describeService = new DescribeService(connectionManager, describeDiskCache);

  // Status bar item: shows Sandbox / Production indicator
  setupOrgTypeStatusBar(context, connectionManager, () => cockpitConfig);

  // Auto-create user folders on first run
  ensureUserFolders(userBasePath);

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

  const monitoringFeature = createMonitoringDashboardFeature({
    builtInPath: path.join(builtInPath, 'monitoring'),
    userPath: path.join(userBasePath, 'monitoring'),
    privatePath: path.join(userBasePath, 'private', 'monitoring'),
    workspaceState: context.workspaceState,
    connectionManager,
    outputChannel,
    postToWebview: (msg) => MainPanel.currentPanel?.postWebviewMessage(msg),
  });

  const allFeatures = [
    ...featureRegistry,
    createYamlScriptsFeature({
      builtInPath: path.join(builtInPath, 'scripts'),
      userPath: path.join(userBasePath, 'scripts'),
      privatePath: path.join(userBasePath, 'private', 'scripts'),
      workspaceRoot,
      workspaceState: context.workspaceState,
      skillsPaths: cockpitConfig.skillsPaths,
      describeService,
      postToWebview: (msg) => MainPanel.currentPanel?.postWebviewMessage(msg),
    }),
    monitoringFeature.factory,
    createExecutionLogsFeature(path.join(userBasePath, 'logs')),
  ];

  // Background auto-refresh: keeps notification-enabled dashboards polling even when
  // the Force Cockpit panel is closed, so threshold and notifyOnIncrease alerts fire.
  async function refreshBackgroundMonitoring(): Promise<void> {
    try {
      const configs = await monitoringFeature.reloadConfigs();
      monitoringFeature.refresher.restart(configs);
    } catch (err) {
      outputChannel.appendLine(
        `[Warn] Monitoring refresher failed to load configs: ${String(err)}`,
      );
    }
  }

  connectionManager.on('connectionChanged', (event: ConnectionChangedEvent) => {
    if (event.connected) {
      void refreshBackgroundMonitoring();
    } else {
      monitoringFeature.refresher.stop();
    }
  });

  context.subscriptions.push({ dispose: () => monitoringFeature.refresher.stop() });

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
      MainPanel.createOrShow(
        context,
        connectionManager,
        allFeatures,
        cockpitConfig,
        describeService,
        outputChannel,
      );
  });
  context.subscriptions.push(sidebarView);

  // --- Commands ---
  context.subscriptions.push(
    vscode.commands.registerCommand('forceCockpit.openPanel', () => {
      MainPanel.createOrShow(
        context,
        connectionManager,
        allFeatures,
        cockpitConfig,
        describeService,
        outputChannel,
      );
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
    const orgController = new OrgConnectionController({
      connectionManager,
      readTargetOrg: () => {
        const raw = fs.readFileSync(sfConfigPath, 'utf8');
        const config = JSON.parse(raw) as Record<string, string>;
        return config['target-org'];
      },
      getOrgDetails,
      refreshOrgToken,
      guardBusy,
      notifyConnecting: (target) => MainPanel.currentPanel?.notifyConnecting(target),
      showWarning: (msg) => void vscode.window.showWarningMessage(msg),
      showInfo: (msg) => void vscode.window.showInformationMessage(msg),
      log: (msg) => outputChannel.appendLine(msg),
    });
    context.subscriptions.push(orgController);

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspaceRoot, '.sf/config.json'),
    );
    watcher.onDidChange(() => orgController.scheduleConnect());
    watcher.onDidCreate(() => orgController.scheduleConnect());
    watcher.onDidDelete(() => orgController.handleConfigDeleted());
    context.subscriptions.push(watcher);

    context.subscriptions.push(
      vscode.commands.registerCommand('forceCockpit.refreshOrg', () => {
        // A manual refresh should always re-pull schema (memory + disk).
        describeService.clearCache();
        return orgController.connectFromConfig({ force: true });
      }),
    );

    // Auto-connect on activation — reuses connectFromConfig() with retry and race-guards
    void orgController.connectFromConfig();
  }
}

export function deactivate(): void {
  // Nothing to clean up — subscriptions handle it
}

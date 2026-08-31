import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ConnectionManager, ConnectionChangedEvent } from './salesforce/connection';
import { MainPanel } from './panels/MainPanel';
import { getOrgDetails, refreshOrgToken } from './utils/sfCli';
import { buildOrgUrl } from './utils/salesforceUrl';
import { featureRegistry } from './features/registry';
import { yamlScriptsFeature } from './features/utils/yaml-scripts/index';
import { executionLogsFeature } from './features/utils/execution-logs/index';
import { createMonitoringDashboardFeature } from './features/monitoring/dashboard/index';
import { debugLogsFeature } from './features/debug-logs/explorer/index';
import { askAiFeature } from './features/overview/ask-ai/index';
import { soqlFeature } from './features/soql/query-editor/index';
import { Logger } from '@salesforce/core';
import { loadConfig } from './utils/config';
import { ensureUserFolders } from './utils/workspaceSetup';
import { setupOrgTypeStatusBar } from './ui/orgTypeStatusBar';
import { OrgConnectionController } from './services/org/OrgConnectionController';
import type { FeatureContext } from './features/FeatureContext';
import { DescribeService } from './services/describe/DescribeService';
import { DescribeDiskCache } from './services/describe/DescribeDiskCache';
import { registerChatModelWatcher } from './services/ai/ChatModelWatcher';
import { VsCodeLmGateway } from './services/ai/LmGateway';
import { VsCodeWorkspaceSearch } from './services/ai/WorkspaceSearch';
import { SkillsRepository } from './services/skills/SkillsRepository';

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

  const connectionManager = new ConnectionManager({
    log: (message) => outputChannel.appendLine(message),
  });

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const builtInPath = path.join(context.extensionPath, 'force-cockpit');
  const userBasePath =
    vscode.workspace.getConfiguration('forceCockpit').get<string>('cockpitPath') ||
    path.join(workspaceRoot, 'force-cockpit');

  let cockpitConfig = loadConfig(context.extensionPath, userBasePath);
  connectionManager.setApiVersion(cockpitConfig.apiVersion);

  // Persistent, per-workspace describe cache shared by the SOQL tab's autocomplete and
  // AI scripts. The disk layer survives reloads; each consumer keeps a cheap in-memory
  // map on top. Cleared on manual org refresh so schema is re-pulled on demand.
  const describeDiskCache = new DescribeDiskCache(path.join(userBasePath, '.describe-cache'));
  const describeService = new DescribeService(connectionManager, describeDiskCache);

  // The two vscode-facing AI adapters, built once and shared by every consumer
  // (AI scripts and the debug-log analyzer).
  const lmGateway = new VsCodeLmGateway();
  const workspaceSearch = new VsCodeWorkspaceSearch();
  // VS Code resolves language models asynchronously, so a picker built before
  // Copilot (or a BYOK provider) finished registering would stay stale for the
  // life of the panel. Push a fresh list whenever the model set changes.
  context.subscriptions.push(
    registerChatModelWatcher({
      gateway: lmGateway,
      post: (msg) => MainPanel.currentPanel?.postWebviewMessage(msg),
      isPanelOpen: () => Boolean(MainPanel.currentPanel),
      log: (message) => outputChannel.appendLine(message),
    }),
  );
  // Agent Skills discovery, built once and shared by AI scripts and the
  // Overview tab's ad-hoc "Ask the AI" chat. Note: skillsPaths is captured
  // here at activation, so a live config.yaml reload does not pick up a
  // changed `skillsPaths` list until the window reloads.
  const skillsRepo = new SkillsRepository(workspaceRoot, cockpitConfig.skillsPaths);

  // Status bar item: shows Sandbox / Production indicator
  setupOrgTypeStatusBar(context, connectionManager, () => cockpitConfig);

  // Auto-create user folders on first run
  ensureUserFolders(userBasePath);

  // Watch config.yaml for live changes
  function reloadConfig(): void {
    cockpitConfig = loadConfig(context.extensionPath, userBasePath);
    connectionManager.setApiVersion(cockpitConfig.apiVersion);
    // No config argument: the panel reads it through `featureCtx.getConfig`,
    // which closes over the `cockpitConfig` reassigned just above.
    MainPanel.currentPanel?.refreshForConfigChange();
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

  // Everything shared, assembled once. Feature factories take this instead of
  // each declaring its own options bag — which is what used to make five of the
  // seven features unable to use `defineFeature` and turned this file into a
  // by-hand wiring exercise.
  //
  // `getConfig` is a getter, not a snapshot, so a live config.yaml reload is
  // observed by whoever reads it: the debug-log noise filter, and MainPanel's
  // own `protectedSandboxes` check (which used to hold a snapshot kept in step
  // by hand from `reloadConfig` above).
  const featureCtx: FeatureContext = {
    connectionManager,
    workspaceState: context.workspaceState,
    describeService,
    gateway: lmGateway,
    workspaceSearch,
    skillsRepo,
    paths: {
      // Note: monitoring/scripts sub-paths are derived per-feature from these.
      builtIn: builtInPath,
      user: userBasePath,
      private: path.join(userBasePath, 'private'),
      workspaceRoot,
      logs: path.join(userBasePath, 'logs'),
    },
    outputChannel,
    postToWebview: (msg) => MainPanel.currentPanel?.postWebviewMessage(msg),
    getConfig: () => cockpitConfig,
  };

  const monitoringFeature = createMonitoringDashboardFeature(featureCtx);

  const allFeatures = [
    ...featureRegistry,
    soqlFeature,
    yamlScriptsFeature,
    monitoringFeature.factory,
    executionLogsFeature,
    debugLogsFeature,
    askAiFeature,
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

    // Reload the scripts list when a script .yaml is hand-edited on disk (e.g. via
    // the edit form's "Open YAML" button) — there is no file watcher on the scripts
    // dirs, so without this the panel's in-memory list would go stale. The form's
    // own Save writes via fs.writeFileSync (not a TextDocument), so it never fires
    // this; the `file` scheme check skips the in-memory "Open in editor" buffers.
    const scriptsUserDir = path.join(userBasePath, 'scripts') + path.sep;
    const scriptsPrivateDir = path.join(userBasePath, 'private', 'scripts') + path.sep;
    context.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (doc.uri.scheme !== 'file' || !/\.ya?ml$/i.test(doc.uri.fsPath)) return;
        const p = doc.uri.fsPath;
        if (p.startsWith(scriptsUserDir) || p.startsWith(scriptsPrivateDir)) {
          MainPanel.currentPanel?.postWebviewMessage({ type: 'reloadYamlScripts' });
        }
      }),
    );
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
  // VSCode has no "activity-bar icon that just runs a command" contribution point —
  // an activity-bar icon must be backed by a view container. So this stays an empty
  // TreeView; the moment it becomes visible we open the real webview panel and
  // immediately close the sidebar again, so the empty view/welcome content never
  // lingers on screen — the icon click reads as "open the panel", not "open a sidebar".
  const emptyProvider: vscode.TreeDataProvider<never> = {
    getTreeItem: (e) => e,
    getChildren: () => [],
  };
  const sidebarView = vscode.window.createTreeView('forceCockpit.panel', {
    treeDataProvider: emptyProvider,
  });
  sidebarView.title = ` v${context.extension.packageJSON.version}`;
  sidebarView.onDidChangeVisibility(({ visible }) => {
    if (!visible) return;
    MainPanel.createOrShow(context, featureCtx, allFeatures);
    void vscode.commands.executeCommand('workbench.action.closeSidebar');
  });
  context.subscriptions.push(sidebarView);

  // --- Commands ---
  context.subscriptions.push(
    vscode.commands.registerCommand('forceCockpit.openPanel', () => {
      MainPanel.createOrShow(context, featureCtx, allFeatures);
    }),

    vscode.commands.registerCommand('forceCockpit.openInBrowser', async () => {
      if (!connectionManager.getCurrentOrg()) {
        vscode.window.showWarningMessage('No org connected.');
        return;
      }
      // frontdoor.jsp needs a live session id; nothing else validates the token on this
      // path, so renew it up front rather than dropping the user on a login page.
      await connectionManager.ensureValidSession();
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

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ConnectionManager } from './salesforce/connection';
import { MainPanel } from './panels/MainPanel';
import { getOrgDetails, refreshOrgToken } from './utils/sfCli';
import { buildOrgUrl } from './utils/salesforceUrl';
import { featureRegistry } from './features/registry';
import { createYamlScriptsFeature } from './features/utils/yaml-scripts/index';
import { createMonitoringDashboardFeature } from './features/monitoring/monitoring-dashboard/index';
import { Logger } from '@salesforce/core';

function ensurePrivateGitignored(workspaceRoot: string): void {
  if (!workspaceRoot) return;
  const gitignorePath = path.join(workspaceRoot, '.gitignore');
  const privateEntry = 'force-cockpit/private/';

  try {
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, `${privateEntry}\n`, 'utf8');
      return;
    }

    const content = fs.readFileSync(gitignorePath, 'utf8');
    const lines = content.split('\n').map((l) => l.trim());
    if (
      lines.some(
        (line) =>
          line === privateEntry ||
          line === 'force-cockpit/private' ||
          line === 'force-cockpit/private/**',
      )
    ) {
      return;
    }

    const separator = content.endsWith('\n') ? '' : '\n';
    fs.appendFileSync(gitignorePath, `${separator}${privateEntry}\n`, 'utf8');
  } catch {
    // Silent — gitignore management is best-effort
  }
}

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

  const connectionManager = new ConnectionManager();

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const builtInPath = path.join(context.extensionPath, 'force-cockpit');
  const userBasePath =
    vscode.workspace.getConfiguration('forceCockpit').get<string>('cockpitPath') ||
    path.join(workspaceRoot, 'force-cockpit');

  // Auto-create user folders on first run
  fs.mkdirSync(path.join(userBasePath, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(userBasePath, 'monitoring'), { recursive: true });
  fs.mkdirSync(path.join(userBasePath, 'private', 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(userBasePath, 'private', 'monitoring'), { recursive: true });

  // Ensure private folder is gitignored so users don't commit private scripts by mistake
  ensurePrivateGitignored(workspaceRoot);

  const allFeatures = [
    ...featureRegistry,
    createYamlScriptsFeature({
      builtInPath: path.join(builtInPath, 'scripts'),
      userPath: path.join(userBasePath, 'scripts'),
      privatePath: path.join(userBasePath, 'private', 'scripts'),
      workspaceRoot,
    }),
    createMonitoringDashboardFeature({
      builtInPath: path.join(builtInPath, 'monitoring'),
      userPath: path.join(userBasePath, 'monitoring'),
      privatePath: path.join(userBasePath, 'private', 'monitoring'),
    }),
  ];

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
  sidebarView.onDidChangeVisibility(({ visible }) => {
    if (visible) MainPanel.createOrShow(context, connectionManager, allFeatures, workspaceRoot);
  });
  context.subscriptions.push(sidebarView);

  // --- Commands ---
  context.subscriptions.push(
    vscode.commands.registerCommand('forceCockpit.openPanel', () => {
      MainPanel.createOrShow(context, connectionManager, allFeatures, workspaceRoot);
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
          if (myVersion !== connectVersion) return;
          try {
            const details = await getOrgDetails(target); // fresh credentials each attempt
            if (myVersion !== connectVersion) return;
            await connectionManager.connect(details);
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
      } catch {
        // Silent — file read / JSON parse errors (workspace not an SFDX project)
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

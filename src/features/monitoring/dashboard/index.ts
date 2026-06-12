import * as path from 'path';
import * as vscode from 'vscode';
import type { ConnectionManager } from '../../../salesforce/connection';
import type { FeatureModule, FeatureModuleFactory } from '../../FeatureModule';
import { MonitoringDashboardService } from './MonitoringDashboardService';
import type { MonitoringConfig } from './types';
import { BackgroundRefresher } from './BackgroundRefresher';
import { loadPersistedSnoozes } from './notifications';
import { buildMonitoringRoutes, loadHiddenBuiltins } from './routes';

export interface MonitoringFeature {
  factory: FeatureModuleFactory;
  /** Background refresher — start/stop driven by extension.ts based on connection state. */
  refresher: BackgroundRefresher;
  /** Refresh the in-host config snapshot (used after activate / connectionChanged). */
  reloadConfigs: () => Promise<MonitoringConfig[]>;
}

export function createMonitoringDashboardFeature(opts: {
  builtInPath: string;
  userPath: string;
  privatePath: string;
  workspaceState: vscode.Memento;
  /** When provided, the refresher and routes use this CM directly (eager construction). */
  connectionManager?: ConnectionManager;
  outputChannel?: vscode.OutputChannel;
  /** Posts background-refresh results to the webview. No-op when MainPanel is closed. */
  postToWebview?: (msg: unknown) => void;
}): MonitoringFeature {
  loadPersistedSnoozes(opts.workspaceState);

  const paths = {
    builtInPath: opts.builtInPath,
    userPath: opts.userPath,
    privatePath: opts.privatePath,
  };
  const postToWebview = opts.postToWebview ?? (() => {});

  // Eagerly construct service + refresher when a CM is provided (production path).
  // When no CM is provided (legacy test path), we lazily build them inside the factory
  // using the CM that MainPanel passes in, and the refresher will be a no-op until then.
  let service: MonitoringDashboardService | null = opts.connectionManager
    ? new MonitoringDashboardService(opts.connectionManager, paths)
    : null;
  let refresher: BackgroundRefresher | null = opts.connectionManager
    ? new BackgroundRefresher({
        service: service!,
        connectionManager: opts.connectionManager,
        workspaceState: opts.workspaceState,
        postToWebview,
        outputChannel: opts.outputChannel,
      })
    : null;

  const factory: FeatureModuleFactory = (connectionManager: ConnectionManager): FeatureModule => {
    if (!service) {
      service = new MonitoringDashboardService(connectionManager, paths);
    }
    if (!refresher) {
      refresher = new BackgroundRefresher({
        service,
        connectionManager,
        workspaceState: opts.workspaceState,
        postToWebview,
        outputChannel: opts.outputChannel,
      });
    }
    const base = path.join('dist', 'features', 'monitoring', 'dashboard');
    return {
      id: 'monitoring-dashboard',
      tab: 'monitoring',
      htmlPath: path.join(base, 'view.html'),
      jsPath: path.join(base, 'view.js'),
      cssPath: path.join(base, 'view.css'),
      labelsPath: path.join(base, 'labels.js'),
      routes: buildMonitoringRoutes({
        service,
        refresher,
        connectionManager,
        workspaceState: opts.workspaceState,
        outputChannel: opts.outputChannel,
      }),
    };
  };

  // Lazy proxy: extension.ts may interact with the refresher before MainPanel opens.
  // When the factory has not yet been invoked, all methods are safe no-ops.
  const refresherProxy: BackgroundRefresher = {
    start(configs: MonitoringConfig[]) {
      refresher?.start(configs);
    },
    stop() {
      refresher?.stop();
    },
    restart(configs: MonitoringConfig[]) {
      refresher?.restart(configs);
    },
    get running() {
      return refresher?.running ?? false;
    },
    get scheduledIds() {
      return refresher?.scheduledIds ?? [];
    },
  } as unknown as BackgroundRefresher;

  const reloadConfigs = async (): Promise<MonitoringConfig[]> => {
    if (!service) return [];
    return service.loadConfigs(loadHiddenBuiltins(opts.workspaceState));
  };

  return { factory, refresher: refresherProxy, reloadConfigs };
}

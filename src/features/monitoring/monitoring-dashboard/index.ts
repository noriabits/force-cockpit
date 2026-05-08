import * as path from 'path';
import * as vscode from 'vscode';
import type { ConnectionManager } from '../../../salesforce/connection';
import type { FeatureModule, FeatureModuleFactory } from '../../FeatureModule';
import { MonitoringDashboardService } from './MonitoringDashboardService';
import type { MonitoringValueField, MonitoringConfig } from './MonitoringDashboardService';
import { BackgroundRefresher } from './BackgroundRefresher';
import {
  checkThresholds,
  fireBreachNotifications,
  checkRowCountIncrease,
  fireRowCountNotifications,
  pruneCooldowns,
  clearAllCooldownsFor,
  clearRowCountBaseline,
  loadPersistedSnoozes,
} from './notifications';

const HIDDEN_BUILTINS_KEY = 'monitoring.hiddenBuiltins';

function loadHiddenBuiltins(workspaceState: vscode.Memento): Set<string> {
  const persisted: string[] = workspaceState.get(HIDDEN_BUILTINS_KEY, []);
  return new Set(persisted);
}

function persistHiddenBuiltins(workspaceState: vscode.Memento, ids: Set<string>): Thenable<void> {
  return workspaceState.update(HIDDEN_BUILTINS_KEY, Array.from(ids));
}

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
    const svc = service;
    const ref = refresher;
    const base = path.join('dist', 'features', 'monitoring', 'monitoring-dashboard');
    return {
      id: 'monitoring-dashboard',
      tab: 'monitoring',
      htmlPath: path.join(base, 'view.html'),
      jsPath: path.join(base, 'view.js'),
      cssPath: path.join(base, 'view.css'),
      labelsPath: path.join(base, 'labels.js'),
      routes: {
        loadMonitoringConfigs: {
          handler: async () => {
            const hidden = loadHiddenBuiltins(opts.workspaceState);
            const configs = await svc.loadConfigs(hidden);
            // Keep the background refresher in sync with whatever the webview just loaded
            ref.restart(configs);
            return { configs, hiddenCount: hidden.size };
          },
          successType: 'loadMonitoringConfigsResult',
          errorType: 'loadMonitoringConfigsError',
        },
        runMonitoringQuery: {
          handler: async (msg) => {
            const result = await svc.runQuery(
              msg.configId as string,
              msg.soql as string,
              msg.labelField as string,
              msg.valueFields as MonitoringValueField[],
            );
            let rowCountIncreased = false;
            if (!(msg.configId as string).startsWith('__preview__')) {
              const configName = (msg.configName as string) ?? (msg.configId as string);
              fireBreachNotifications(
                checkThresholds(
                  msg.configId as string,
                  configName,
                  result.datasets,
                  msg.valueFields as MonitoringValueField[],
                ),
                opts.workspaceState,
              );
              const rowCountMessages = checkRowCountIncrease(
                msg.configId as string,
                configName,
                result.totalRows,
                Boolean(msg.notifyOnIncrease),
              );
              fireRowCountNotifications(rowCountMessages, opts.outputChannel);
              rowCountIncreased = rowCountMessages.length > 0;
            }
            return { ...result, rowCountIncreased };
          },
          successType: 'runMonitoringQueryResult',
          errorType: 'runMonitoringQueryError',
        },
        runMonitoringTableQuery: {
          handler: async (msg) => {
            const result = await svc.runTableQuery(
              msg.configId as string,
              msg.soql as string,
              msg.labelField as string,
              msg.valueFields as MonitoringValueField[],
            );
            let rowCountIncreased = false;
            if (!(msg.configId as string).startsWith('__preview__')) {
              const valueFields = msg.valueFields as MonitoringValueField[];
              const offset = (msg.labelField as string) ? 1 : 0;
              const datasets = valueFields.map((_, i) => ({
                data: result.rows.map((row) => Number(row[offset + i]) || 0),
              }));
              const configName = (msg.configName as string) ?? (msg.configId as string);
              fireBreachNotifications(
                checkThresholds(msg.configId as string, configName, datasets, valueFields),
                opts.workspaceState,
              );
              const rowCountMessages = checkRowCountIncrease(
                msg.configId as string,
                configName,
                result.totalRows,
                Boolean(msg.notifyOnIncrease),
              );
              fireRowCountNotifications(rowCountMessages, opts.outputChannel);
              rowCountIncreased = rowCountMessages.length > 0;
            }
            return { ...result, rowCountIncreased };
          },
          successType: 'runMonitoringTableQueryResult',
          errorType: 'runMonitoringTableQueryError',
        },
        saveMonitoringConfig: {
          handler: async (msg) => {
            const saved = svc.saveConfig(msg.config as MonitoringConfig, msg.isPrivate as boolean);
            pruneCooldowns(saved.id, saved.valueFields, opts.workspaceState);
            clearRowCountBaseline(saved.id);
            const hidden = loadHiddenBuiltins(opts.workspaceState);
            const configs = await svc.loadConfigs(hidden);
            ref.restart(configs);
            return { config: saved };
          },
          successType: 'saveMonitoringConfigResult',
          errorType: 'saveMonitoringConfigError',
        },
        saveMonitoringPositions: {
          handler: async (msg) => {
            await svc.savePositions(
              msg.positions as Array<{ id: string; position: number; source: string }>,
            );
            return {};
          },
          successType: 'saveMonitoringPositionsResult',
          errorType: 'saveMonitoringPositionsError',
        },
        deleteMonitoringConfig: {
          handler: async (msg) => {
            const configId = msg.configId as string;
            const configName = (msg.configName as string) || configId;
            const source = msg.source as 'builtin' | 'user' | 'private';
            const isPrivate = msg.isPrivate as boolean;
            const confirmed = await vscode.window.showWarningMessage(
              `Delete "${configName}"? This cannot be undone.`,
              { modal: true },
              'Delete',
            );
            if (confirmed !== 'Delete') return { deleted: false };
            if (source === 'builtin') {
              const hidden = loadHiddenBuiltins(opts.workspaceState);
              hidden.add(configId);
              await persistHiddenBuiltins(opts.workspaceState, hidden);
            } else {
              svc.deleteConfig(configId, isPrivate);
            }
            clearAllCooldownsFor(configId, opts.workspaceState);
            clearRowCountBaseline(configId);

            const remaining = await svc.loadConfigs(loadHiddenBuiltins(opts.workspaceState));
            const sorted = remaining.slice().sort((a, b) => {
              const pa = a.position ?? Number.POSITIVE_INFINITY;
              const pb = b.position ?? Number.POSITIVE_INFINITY;
              if (pa !== pb) return pa - pb;
              return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
            });
            await svc.savePositions(
              sorted.map((c, idx) => ({
                id: c.id,
                position: idx,
                source: c.source ?? 'user',
              })),
            );
            ref.restart(sorted);
            return { deleted: true };
          },
          successType: 'deleteMonitoringConfigResult',
          errorType: 'deleteMonitoringConfigError',
        },
        restoreHiddenBuiltins: {
          handler: async () => {
            await persistHiddenBuiltins(opts.workspaceState, new Set());
            const configs = await svc.loadConfigs(new Set());
            ref.restart(configs);
            return { restored: true };
          },
          successType: 'restoreHiddenBuiltinsResult',
          errorType: 'restoreHiddenBuiltinsError',
        },
      },
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
    const hidden = loadHiddenBuiltins(opts.workspaceState);
    return service.loadConfigs(hidden);
  };

  return { factory, refresher: refresherProxy, reloadConfigs };
}

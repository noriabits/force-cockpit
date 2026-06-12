import * as vscode from 'vscode';
import type { RouteDescriptor } from '../../FeatureModule';
import type { ConnectionManager } from '../../../salesforce/connection';
import type { MonitoringDashboardService } from './MonitoringDashboardService';
import type { MonitoringConfig, MonitoringValueField } from './types';
import type { BackgroundRefresher } from './BackgroundRefresher';
import {
  checkThresholds,
  fireBreachNotifications,
  checkRowCountIncrease,
  fireRowCountNotifications,
  pruneCooldowns,
  clearAllCooldownsFor,
  clearRowCountBaseline,
} from './notifications';

const HIDDEN_BUILTINS_KEY = 'monitoring.hiddenBuiltins';

export function loadHiddenBuiltins(workspaceState: vscode.Memento): Set<string> {
  const persisted: string[] = workspaceState.get(HIDDEN_BUILTINS_KEY, []);
  return new Set(persisted);
}

function persistHiddenBuiltins(workspaceState: vscode.Memento, ids: Set<string>): Thenable<void> {
  return workspaceState.update(HIDDEN_BUILTINS_KEY, Array.from(ids));
}

export interface MonitoringRoutesDeps {
  service: MonitoringDashboardService;
  refresher: BackgroundRefresher;
  connectionManager: ConnectionManager;
  workspaceState: vscode.Memento;
  outputChannel?: vscode.OutputChannel;
}

/**
 * Fires threshold-breach + row-count notifications for a query result and
 * returns whether the row count increased. Shared by the chart and table routes
 * (which differ only in how they shape the `datasets` they feed `checkThresholds`).
 */
function fireQueryNotifications(
  configId: string,
  configName: string,
  datasets: Array<{ data: number[] }>,
  valueFields: MonitoringValueField[],
  totalRows: number,
  notifyOnIncrease: boolean,
  deps: MonitoringRoutesDeps,
): boolean {
  fireBreachNotifications(
    checkThresholds(configId, configName, datasets, valueFields),
    deps.workspaceState,
  );
  const orgKey = deps.connectionManager.getCurrentOrg()?.username ?? '';
  const rowCountMessages = checkRowCountIncrease(
    configId,
    orgKey,
    configName,
    totalRows,
    notifyOnIncrease,
  );
  fireRowCountNotifications(rowCountMessages, deps.outputChannel);
  return rowCountMessages.length > 0;
}

export function buildMonitoringRoutes(deps: MonitoringRoutesDeps): Record<string, RouteDescriptor> {
  const { service, refresher, workspaceState } = deps;

  return {
    loadMonitoringConfigs: {
      handler: async () => {
        const hidden = loadHiddenBuiltins(workspaceState);
        const configs = await service.loadConfigs(hidden);
        // Keep the background refresher in sync with whatever the webview just loaded
        refresher.restart(configs);
        return { configs, hiddenCount: hidden.size };
      },
      successType: 'loadMonitoringConfigsResult',
      errorType: 'loadMonitoringConfigsError',
    },
    runMonitoringQuery: {
      handler: async (msg) => {
        const configId = msg.configId as string;
        const result = await service.runQuery(
          configId,
          msg.soql as string,
          msg.labelField as string,
          msg.valueFields as MonitoringValueField[],
        );
        let rowCountIncreased = false;
        if (!configId.startsWith('__preview__')) {
          const configName = (msg.configName as string) ?? configId;
          rowCountIncreased = fireQueryNotifications(
            configId,
            configName,
            result.datasets,
            msg.valueFields as MonitoringValueField[],
            result.totalRows,
            Boolean(msg.notifyOnIncrease),
            deps,
          );
        }
        return { ...result, rowCountIncreased };
      },
      successType: 'runMonitoringQueryResult',
      errorType: 'runMonitoringQueryError',
    },
    runMonitoringTableQuery: {
      handler: async (msg) => {
        const configId = msg.configId as string;
        const result = await service.runTableQuery(
          configId,
          msg.soql as string,
          msg.labelField as string,
          msg.valueFields as MonitoringValueField[],
        );
        let rowCountIncreased = false;
        if (!configId.startsWith('__preview__')) {
          const valueFields = msg.valueFields as MonitoringValueField[];
          const offset = (msg.labelField as string) ? 1 : 0;
          const datasets = valueFields.map((_, i) => ({
            data: result.rows.map((row) => Number(row[offset + i]) || 0),
          }));
          const configName = (msg.configName as string) ?? configId;
          rowCountIncreased = fireQueryNotifications(
            configId,
            configName,
            datasets,
            valueFields,
            result.totalRows,
            Boolean(msg.notifyOnIncrease),
            deps,
          );
        }
        return { ...result, rowCountIncreased };
      },
      successType: 'runMonitoringTableQueryResult',
      errorType: 'runMonitoringTableQueryError',
    },
    saveMonitoringConfig: {
      handler: async (msg) => {
        const saved = service.saveConfig(msg.config as MonitoringConfig, msg.isPrivate as boolean);
        pruneCooldowns(saved.id, saved.valueFields, workspaceState);
        clearRowCountBaseline(saved.id);
        const configs = await service.loadConfigs(loadHiddenBuiltins(workspaceState));
        refresher.restart(configs);
        return { config: saved };
      },
      successType: 'saveMonitoringConfigResult',
      errorType: 'saveMonitoringConfigError',
    },
    saveMonitoringPositions: {
      handler: async (msg) => {
        await service.savePositions(
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
          const hidden = loadHiddenBuiltins(workspaceState);
          hidden.add(configId);
          await persistHiddenBuiltins(workspaceState, hidden);
        } else {
          service.deleteConfig(configId, isPrivate);
        }
        clearAllCooldownsFor(configId, workspaceState);
        clearRowCountBaseline(configId);

        const remaining = await service.loadConfigs(loadHiddenBuiltins(workspaceState));
        const sorted = remaining.slice().sort((a, b) => {
          const pa = a.position ?? Number.POSITIVE_INFINITY;
          const pb = b.position ?? Number.POSITIVE_INFINITY;
          if (pa !== pb) return pa - pb;
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
        await service.savePositions(
          sorted.map((c, idx) => ({
            id: c.id,
            position: idx,
            source: c.source ?? 'user',
          })),
        );
        refresher.restart(sorted);
        return { deleted: true };
      },
      successType: 'deleteMonitoringConfigResult',
      errorType: 'deleteMonitoringConfigError',
    },
    restoreHiddenBuiltins: {
      handler: async () => {
        await persistHiddenBuiltins(workspaceState, new Set());
        const configs = await service.loadConfigs(new Set());
        refresher.restart(configs);
        return { restored: true };
      },
      successType: 'restoreHiddenBuiltinsResult',
      errorType: 'restoreHiddenBuiltinsError',
    },
  };
}

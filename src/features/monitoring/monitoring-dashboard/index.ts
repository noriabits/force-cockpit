import * as path from 'path';
import * as vscode from 'vscode';
import type { ConnectionManager } from '../../../salesforce/connection';
import type { FeatureModule, FeatureModuleFactory } from '../../FeatureModule';
import { MonitoringDashboardService } from './MonitoringDashboardService';
import type { MonitoringValueField, MonitoringConfig } from './MonitoringDashboardService';

/** Maps cooldownKey → "silence until" timestamp */
const notificationCooldowns = new Map<string, number>();
const COOLDOWN_MS = 60_000;
const SNOOZE_1H_MS = 60 * 60 * 1000;

function formatValueForNotification(value: number, format?: string): string {
  if (format === 'currency')
    return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (format === 'percent') return value.toFixed(1) + '%';
  return value.toLocaleString();
}

function checkThresholds(
  configId: string,
  configName: string,
  datasets: Array<{ data: number[] }>,
  valueFields: MonitoringValueField[],
): Array<{ message: string; cooldownKey: string }> {
  const now = Date.now();
  const breaches: Array<{ message: string; cooldownKey: string }> = [];
  for (let i = 0; i < valueFields.length; i++) {
    const vf = valueFields[i];
    if (vf.threshold == null) continue;
    const condition = vf.thresholdCondition ?? 'above';
    const data = datasets[i]?.data ?? [];
    const breached = data.some((v) =>
      condition === 'above' ? v >= vf.threshold! : v <= vf.threshold!,
    );
    if (!breached) continue;
    const cooldownKey = `${configId}:${i}`;
    const silenceUntil = notificationCooldowns.get(cooldownKey) ?? 0;
    if (now < silenceUntil) continue;
    notificationCooldowns.set(cooldownKey, now + COOLDOWN_MS);
    const worst = condition === 'above' ? Math.max(...data) : Math.min(...data);
    const formatted = formatValueForNotification(worst, vf.format);
    const conditionWord = condition === 'above' ? 'exceeded' : 'fell below';
    breaches.push({
      message: `[${configName}] ${vf.label || vf.field} ${conditionWord} threshold of ${vf.threshold} (current: ${formatted})`,
      cooldownKey,
    });
  }
  return breaches;
}

function fireBreachNotifications(breaches: Array<{ message: string; cooldownKey: string }>): void {
  for (const { message, cooldownKey } of breaches) {
    vscode.window.showWarningMessage(message, 'Snooze 1h', 'Snooze for today').then((selection) => {
      if (selection === 'Snooze 1h') {
        notificationCooldowns.set(cooldownKey, Date.now() + SNOOZE_1H_MS);
      } else if (selection === 'Snooze for today') {
        const midnight = new Date();
        midnight.setHours(24, 0, 0, 0);
        notificationCooldowns.set(cooldownKey, midnight.getTime());
      }
    });
  }
}

export function createMonitoringDashboardFeature(paths: {
  builtInPath: string;
  userPath: string;
  privatePath: string;
}): FeatureModuleFactory {
  return (connectionManager: ConnectionManager): FeatureModule => {
    const service = new MonitoringDashboardService(connectionManager, paths);
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
          handler: async () => ({ configs: await service.loadConfigs() }),
          successType: 'loadMonitoringConfigsResult',
          errorType: 'loadMonitoringConfigsError',
        },
        runMonitoringQuery: {
          handler: async (msg) => {
            const result = await service.runQuery(
              msg.configId as string,
              msg.soql as string,
              msg.labelField as string,
              msg.valueFields as MonitoringValueField[],
            );
            if (!(msg.configId as string).startsWith('__preview__')) {
              fireBreachNotifications(
                checkThresholds(
                  msg.configId as string,
                  (msg.configName as string) ?? (msg.configId as string),
                  result.datasets,
                  msg.valueFields as MonitoringValueField[],
                ),
              );
            }
            return result;
          },
          successType: 'runMonitoringQueryResult',
          errorType: 'runMonitoringQueryError',
        },
        runMonitoringTableQuery: {
          handler: async (msg) => {
            const result = await service.runTableQuery(
              msg.configId as string,
              msg.soql as string,
              msg.labelField as string,
              msg.valueFields as MonitoringValueField[],
            );
            if (!(msg.configId as string).startsWith('__preview__')) {
              const valueFields = msg.valueFields as MonitoringValueField[];
              const offset = (msg.labelField as string) ? 1 : 0;
              const datasets = valueFields.map((_, i) => ({
                data: result.rows.map((row) => Number(row[offset + i]) || 0),
              }));
              fireBreachNotifications(
                checkThresholds(
                  msg.configId as string,
                  (msg.configName as string) ?? (msg.configId as string),
                  datasets,
                  valueFields,
                ),
              );
            }
            return result;
          },
          successType: 'runMonitoringTableQueryResult',
          errorType: 'runMonitoringTableQueryError',
        },
        saveMonitoringConfig: {
          handler: async (msg) => {
            const saved = service.saveConfig(
              msg.config as MonitoringConfig,
              msg.isPrivate as boolean,
            );
            return { config: saved };
          },
          successType: 'saveMonitoringConfigResult',
          errorType: 'saveMonitoringConfigError',
        },
      },
    };
  };
}

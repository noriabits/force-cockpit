import * as vscode from 'vscode';
import type { ConnectionManager } from '../../../salesforce/connection';
import {
  MonitoringDashboardService,
  type MonitoringConfig,
  type MonitoringValueField,
} from './MonitoringDashboardService';
import {
  checkThresholds,
  fireBreachNotifications,
  checkRowCountIncrease,
  fireRowCountNotifications,
} from './notifications';
import { hasNotifications } from './notification-config';

// Re-exported so existing importers (and tests) keep working after the
// predicate moved to the leaf `notification-config` module shared with the webview.
export { hasNotifications };

const MIN_REFRESH_INTERVAL_SECONDS = 10;

interface RefresherOptions {
  service: MonitoringDashboardService;
  connectionManager: ConnectionManager;
  workspaceState: vscode.Memento;
  postToWebview: (msg: unknown) => void;
  outputChannel?: vscode.OutputChannel;
}

export class BackgroundRefresher {
  private readonly _timers = new Map<string, ReturnType<typeof setInterval>>();
  private _running = false;

  constructor(private readonly opts: RefresherOptions) {}

  /** Replace the current timer set with one timer per notification-enabled config. */
  start(configs: MonitoringConfig[]): void {
    this.stop();
    this._running = true;
    for (const cfg of configs) {
      if (!cfg) continue;
      if (cfg.id?.startsWith('__preview__')) continue;
      if (!cfg.refreshInterval || cfg.refreshInterval <= 0) continue;
      if (!hasNotifications(cfg)) continue;
      const intervalSec = Math.max(cfg.refreshInterval, MIN_REFRESH_INTERVAL_SECONDS);
      const handle = setInterval(() => {
        void this._tick(cfg);
      }, intervalSec * 1000);
      this._timers.set(cfg.id, handle);
    }
  }

  stop(): void {
    for (const handle of this._timers.values()) clearInterval(handle);
    this._timers.clear();
    this._running = false;
  }

  /** Convenience: stop + start with a fresh config snapshot. */
  restart(configs: MonitoringConfig[]): void {
    this.start(configs);
  }

  /** Visible for tests. */
  get running(): boolean {
    return this._running;
  }

  /** Visible for tests. */
  get scheduledIds(): string[] {
    return Array.from(this._timers.keys());
  }

  private currentOrgKey(): string {
    return this.opts.connectionManager.getCurrentOrg()?.username ?? '';
  }

  private async _tick(cfg: MonitoringConfig): Promise<void> {
    if (!this.opts.connectionManager.isConnected) return;
    try {
      if (cfg.chartType === 'table') {
        await this._tickTable(cfg);
      } else {
        await this._tickChart(cfg);
      }
    } catch (err) {
      this.opts.outputChannel?.appendLine(
        `[Warn] Monitoring background refresh failed for ${cfg.id}: ${String(err)}`,
      );
    }
  }

  private async _tickChart(cfg: MonitoringConfig): Promise<void> {
    const result = await this.opts.service.runQuery(
      cfg.id,
      cfg.soql,
      cfg.labelField,
      cfg.valueFields,
    );
    fireBreachNotifications(
      checkThresholds(cfg.id, cfg.name, result.datasets, cfg.valueFields),
      this.opts.workspaceState,
    );
    const rowCountMessages = checkRowCountIncrease(
      cfg.id,
      this.currentOrgKey(),
      cfg.name,
      result.totalRows,
      Boolean(cfg.notifyOnIncrease),
    );
    fireRowCountNotifications(rowCountMessages, this.opts.outputChannel);
    this.opts.postToWebview({
      type: 'monitoringBackgroundRefreshResult',
      data: {
        configId: cfg.id,
        chartType: cfg.chartType,
        result,
        rowCountIncreased: rowCountMessages.length > 0,
      },
    });
  }

  private async _tickTable(cfg: MonitoringConfig): Promise<void> {
    const result = await this.opts.service.runTableQuery(
      cfg.id,
      cfg.soql,
      cfg.labelField,
      cfg.valueFields,
    );
    const offset = cfg.labelField ? 1 : 0;
    const datasets = (cfg.valueFields as MonitoringValueField[]).map((_, i) => ({
      data: result.rows.map((row) => Number(row[offset + i]) || 0),
    }));
    fireBreachNotifications(
      checkThresholds(cfg.id, cfg.name, datasets, cfg.valueFields),
      this.opts.workspaceState,
    );
    const rowCountMessages = checkRowCountIncrease(
      cfg.id,
      this.currentOrgKey(),
      cfg.name,
      result.totalRows,
      Boolean(cfg.notifyOnIncrease),
    );
    fireRowCountNotifications(rowCountMessages, this.opts.outputChannel);
    this.opts.postToWebview({
      type: 'monitoringBackgroundRefreshResult',
      data: {
        configId: cfg.id,
        chartType: cfg.chartType,
        result,
        rowCountIncreased: rowCountMessages.length > 0,
      },
    });
  }
}

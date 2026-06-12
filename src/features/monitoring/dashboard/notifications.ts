import * as vscode from 'vscode';
import type { MonitoringValueField } from './MonitoringDashboardService';
import { playRowCountPing } from './audio';

const COOLDOWN_MS = 60_000;
const SNOOZE_1H_MS = 60 * 60 * 1000;
const STORAGE_KEY = 'monitoring.notificationCooldowns';

/** Maps cooldownKey → "silence until" timestamp */
const notificationCooldowns = new Map<string, number>();
/** configId → (orgKey → most recent totalRows seen), for "notify on increase" detection */
const previousRowCounts = new Map<string, Map<string, number>>();

export function loadPersistedSnoozes(workspaceState: vscode.Memento): void {
  const persisted: Record<string, number> = workspaceState.get(STORAGE_KEY, {});
  const now = Date.now();
  for (const [key, until] of Object.entries(persisted)) {
    if (until > now) notificationCooldowns.set(key, until);
  }
}

function persistSnoozes(workspaceState: vscode.Memento): void {
  const now = Date.now();
  const toSave: Record<string, number> = {};
  for (const [key, until] of notificationCooldowns) {
    if (until > now && until - now > COOLDOWN_MS) toSave[key] = until;
  }
  void workspaceState.update(STORAGE_KEY, toSave);
}

export function clearAllCooldownsFor(configId: string, workspaceState: vscode.Memento): void {
  let changed = false;
  for (const [key] of notificationCooldowns) {
    if (key.startsWith(configId + ':')) {
      notificationCooldowns.delete(key);
      changed = true;
    }
  }
  if (changed) persistSnoozes(workspaceState);
}

export function pruneCooldowns(
  configId: string,
  valueFields: MonitoringValueField[],
  workspaceState: vscode.Memento,
): void {
  let changed = false;
  for (const [key] of notificationCooldowns) {
    if (!key.startsWith(configId + ':')) continue;
    const idx = parseInt(key.split(':')[1], 10);
    if (isNaN(idx) || idx >= valueFields.length || valueFields[idx]?.threshold == null) {
      notificationCooldowns.delete(key);
      changed = true;
    }
  }
  if (changed) persistSnoozes(workspaceState);
}

export function clearRowCountBaseline(configId: string): void {
  previousRowCounts.delete(configId);
}

function formatValueForNotification(value: number, format?: string): string {
  if (format === 'currency')
    return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (format === 'percent') return value.toFixed(1) + '%';
  return value.toLocaleString();
}

export interface ThresholdBreach {
  message: string;
  cooldownKey: string;
}

export function checkThresholds(
  configId: string,
  configName: string,
  datasets: Array<{ data: number[] }>,
  valueFields: MonitoringValueField[],
): ThresholdBreach[] {
  const now = Date.now();
  const breaches: ThresholdBreach[] = [];
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

export function fireBreachNotifications(
  breaches: ThresholdBreach[],
  workspaceState: vscode.Memento,
): void {
  for (const { message, cooldownKey } of breaches) {
    vscode.window.showWarningMessage(message, 'Snooze 1h', 'Snooze for today').then((selection) => {
      if (selection === 'Snooze 1h') {
        notificationCooldowns.set(cooldownKey, Date.now() + SNOOZE_1H_MS);
        persistSnoozes(workspaceState);
      } else if (selection === 'Snooze for today') {
        const midnight = new Date();
        midnight.setHours(24, 0, 0, 0);
        notificationCooldowns.set(cooldownKey, midnight.getTime());
        persistSnoozes(workspaceState);
      }
    });
  }
}

export function checkRowCountIncrease(
  configId: string,
  orgKey: string,
  configName: string,
  totalRows: number,
  notifyOnIncrease: boolean,
): string[] {
  let perOrg = previousRowCounts.get(configId);
  if (!perOrg) {
    perOrg = new Map();
    previousRowCounts.set(configId, perOrg);
  }
  const prev = perOrg.get(orgKey);
  perOrg.set(orgKey, totalRows);
  if (!notifyOnIncrease || prev === undefined || totalRows <= prev) return [];
  const delta = totalRows - prev;
  return [`[${configName}] ${delta} new record${delta === 1 ? '' : 's'} (${prev} → ${totalRows})`];
}

export function fireRowCountNotifications(
  messages: string[],
  outputChannel?: vscode.OutputChannel,
): void {
  if (messages.length === 0) return;
  playRowCountPing(outputChannel);
  for (const message of messages) {
    void vscode.window.showWarningMessage(message);
  }
}

/** Test-only: reset all in-memory notification state. Not used at runtime. */
export function __resetNotificationStateForTests(): void {
  notificationCooldowns.clear();
  previousRowCounts.clear();
}

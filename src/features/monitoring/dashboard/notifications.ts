import * as vscode from 'vscode';
import type { MonitoringValueField } from './MonitoringDashboardService';
import { playRowCountPing } from './audio';
import type { ConnectionManager } from '../../../salesforce/connection';

const COOLDOWN_MS = 60_000;
const SNOOZE_1H_MS = 60 * 60 * 1000;
const STORAGE_KEY = 'monitoring.notificationCooldowns';
/** Second segment of a row-count snooze key (`configId:rows:orgKey`); threshold keys carry the value-field index there instead. */
const SNOOZE_1H_LABEL = 'Snooze 1h';
const SNOOZE_TODAY_LABEL = 'Snooze for today';
const ROW_COUNT_KEY_PART = 'rows';

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
  notifyOnIncrease: boolean,
  workspaceState: vscode.Memento,
): void {
  let changed = false;
  for (const [key] of notificationCooldowns) {
    if (!key.startsWith(configId + ':')) continue;
    const part = key.split(':')[1];
    const stale =
      part === ROW_COUNT_KEY_PART
        ? !notifyOnIncrease
        : isStaleThresholdIndex(parseInt(part, 10), valueFields);
    if (stale) {
      notificationCooldowns.delete(key);
      changed = true;
    }
  }
  if (changed) persistSnoozes(workspaceState);
}

function isStaleThresholdIndex(idx: number, valueFields: MonitoringValueField[]): boolean {
  return isNaN(idx) || idx >= valueFields.length || valueFields[idx]?.threshold == null;
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

/**
 * What a notification shows for the org: the alias when there is one; otherwise
 * "Production" for production, or the last `.`-separated part of the username
 * (the sandbox name in `user@company.com.sandbox`) — the full username is too long.
 */
export function orgLabelOf(
  org: { alias?: string; username: string } | null,
  isProduction: boolean,
): string {
  if (!org) return '';
  if (org.alias) return org.alias;
  if (isProduction) return 'Production';
  return org.username.slice(org.username.lastIndexOf('.') + 1);
}

/** The label for whichever org is connected right now. Production = no sandbox name in the instance URL, the same rule the banner uses. */
export function currentOrgLabel(
  connectionManager: Pick<ConnectionManager, 'getCurrentOrg' | 'getSandboxName'>,
): string {
  return orgLabelOf(connectionManager.getCurrentOrg(), connectionManager.getSandboxName() === null);
}

/** `[Config · org]`, or `[Config]` when no org is known. */
function notificationTag(configName: string, orgLabel: string): string {
  return orgLabel ? `[${configName} · ${orgLabel}]` : `[${configName}]`;
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
  orgKey = '',
  orgLabel = '',
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
    const cooldownKey = `${configId}:${i}:${orgKey}`;
    const silenceUntil = notificationCooldowns.get(cooldownKey) ?? 0;
    if (now < silenceUntil) continue;
    notificationCooldowns.set(cooldownKey, now + COOLDOWN_MS);
    const worst = condition === 'above' ? Math.max(...data) : Math.min(...data);
    const formatted = formatValueForNotification(worst, vf.format);
    const conditionWord = condition === 'above' ? 'exceeded' : 'fell below';
    breaches.push({
      message: `${notificationTag(configName, orgLabel)} ${vf.label || vf.field} ${conditionWord} threshold of ${vf.threshold} (current: ${formatted})`,
      cooldownKey,
    });
  }
  return breaches;
}

function applySnooze(
  selection: string | undefined,
  cooldownKey: string,
  workspaceState: vscode.Memento,
): void {
  if (selection === SNOOZE_1H_LABEL) {
    notificationCooldowns.set(cooldownKey, Date.now() + SNOOZE_1H_MS);
  } else if (selection === SNOOZE_TODAY_LABEL) {
    const midnight = new Date();
    midnight.setHours(24, 0, 0, 0);
    notificationCooldowns.set(cooldownKey, midnight.getTime());
  } else {
    return;
  }
  persistSnoozes(workspaceState);
}

function showSnoozableWarning(
  message: string,
  cooldownKey: string,
  workspaceState: vscode.Memento,
): void {
  vscode.window
    .showWarningMessage(message, SNOOZE_1H_LABEL, SNOOZE_TODAY_LABEL)
    .then((selection) => applySnooze(selection, cooldownKey, workspaceState));
}

export function fireBreachNotifications(
  breaches: ThresholdBreach[],
  workspaceState: vscode.Memento,
): void {
  for (const { message, cooldownKey } of breaches) {
    showSnoozableWarning(message, cooldownKey, workspaceState);
  }
}

export interface RowCountIncrease {
  message: string;
  cooldownKey: string;
}

export function checkRowCountIncrease(
  configId: string,
  orgKey: string,
  configName: string,
  totalRows: number,
  notifyOnIncrease: boolean,
  orgLabel = '',
): RowCountIncrease[] {
  let perOrg = previousRowCounts.get(configId);
  if (!perOrg) {
    perOrg = new Map();
    previousRowCounts.set(configId, perOrg);
  }
  const prev = perOrg.get(orgKey);
  perOrg.set(orgKey, totalRows);
  if (!notifyOnIncrease || prev === undefined || totalRows <= prev) return [];
  const delta = totalRows - prev;
  return [
    {
      message: `${notificationTag(configName, orgLabel)} ${delta} new record${delta === 1 ? '' : 's'} (${prev} → ${totalRows})`,
      cooldownKey: `${configId}:${ROW_COUNT_KEY_PART}:${orgKey}`,
    },
  ];
}

export function fireRowCountNotifications(
  increases: RowCountIncrease[],
  workspaceState: vscode.Memento,
  outputChannel?: vscode.OutputChannel,
): void {
  const now = Date.now();
  const audible = increases.filter((i) => now >= (notificationCooldowns.get(i.cooldownKey) ?? 0));
  if (audible.length === 0) return;
  playRowCountPing(outputChannel);
  for (const { message, cooldownKey } of audible) {
    showSnoozableWarning(message, cooldownKey, workspaceState);
  }
}

/** Test-only: reset all in-memory notification state. Not used at runtime. */
export function __resetNotificationStateForTests(): void {
  notificationCooldowns.clear();
  previousRowCounts.clear();
}

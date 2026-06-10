import * as vscode from 'vscode';
import { ConnectionManager, ConnectionChangedEvent } from '../salesforce/connection';
import { CockpitConfig } from '../utils/config';
import { resolveOrgType } from '../utils/orgType';

/**
 * Creates and wires the status-bar org-type indicator (Production / Protected Sandbox /
 * Sandbox). Subscribes to `connectionChanged`: hides on disconnect, otherwise resolves the
 * org type via {@link resolveOrgType} and renders the matching label + theme colors.
 * `getConfig` is called lazily so live config reloads pick up new `protectedSandboxes`.
 */
export function setupOrgTypeStatusBar(
  context: vscode.ExtensionContext,
  connectionManager: ConnectionManager,
  getConfig: () => CockpitConfig,
): void {
  const orgTypeItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  orgTypeItem.tooltip = 'Force Cockpit: org type';
  context.subscriptions.push(orgTypeItem);

  connectionManager.on('connectionChanged', (event: ConnectionChangedEvent) => {
    if (!event.connected) {
      orgTypeItem.hide();
      return;
    }
    void (async () => {
      try {
        const orgType = await resolveOrgType(connectionManager, getConfig().protectedSandboxes);
        switch (orgType) {
          case 'production':
            orgTypeItem.text = '$(circle-filled) Production';
            orgTypeItem.color = new vscode.ThemeColor('errorForeground');
            orgTypeItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            break;
          case 'protected-sandbox':
            orgTypeItem.text = '$(circle-filled) Protected Sandbox';
            orgTypeItem.color = new vscode.ThemeColor('charts.yellow');
            orgTypeItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            break;
          case 'sandbox':
            orgTypeItem.text = '$(circle-filled) Sandbox';
            orgTypeItem.color = new vscode.ThemeColor('testing.iconPassed');
            orgTypeItem.backgroundColor = undefined;
            break;
        }
        orgTypeItem.show();
      } catch {
        orgTypeItem.hide();
      }
    })();
  });
}

import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import type { ConnectionManager } from '../../../salesforce/connection';
import type { FeatureModule, FeatureModuleFactory } from '../../FeatureModule';

export function createExecutionLogsFeature(logsDir: string): FeatureModuleFactory {
  return (_connectionManager: ConnectionManager): FeatureModule => {
    const base = path.join('dist', 'features', 'utils', 'execution-logs');
    return {
      id: 'execution-logs',
      tab: 'utils-logs',
      htmlPath: path.join(base, 'view.html'),
      jsPath: path.join(base, 'view.js'),
      cssPath: path.join(base, 'view.css'),
      routes: {
        loadExecutionLogs: {
          handler: async () => {
            if (!fs.existsSync(logsDir)) return { logs: [] };
            const files = fs.readdirSync(logsDir).filter((f) => f.endsWith('.log'));
            const logs = files
              .map((filename) => {
                const stat = fs.statSync(path.join(logsDir, filename));
                return { filename, createdAt: stat.birthtimeMs || stat.mtimeMs };
              })
              .sort((a, b) => b.createdAt - a.createdAt);
            return { logs };
          },
          successType: 'loadExecutionLogsResult',
          errorType: 'loadExecutionLogsError',
        },
        openExecutionLog: {
          handler: async (msg) => {
            const filename = msg.filename as string;
            const absPath = path.join(logsDir, filename);
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absPath));
            await vscode.window.showTextDocument(doc);
            return {};
          },
          successType: 'openExecutionLogResult',
          errorType: 'openExecutionLogError',
        },
        deleteExecutionLogs: {
          handler: async (msg) => {
            const filenames = msg.filenames as string[];
            const count = filenames.length;
            const label = count === 1 ? `"${filenames[0]}"` : `${count} logs`;
            const confirmed = await vscode.window.showWarningMessage(
              `Delete ${label}? This cannot be undone.`,
              { modal: true },
              'Delete',
            );
            if (confirmed !== 'Delete') return { deleted: false };
            for (const filename of filenames) {
              const absPath = path.join(logsDir, filename);
              if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
            }
            return { deleted: true, count };
          },
          successType: 'deleteExecutionLogsResult',
          errorType: 'deleteExecutionLogsError',
        },
      },
    };
  };
}

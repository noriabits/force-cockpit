// SOQL feature factory. Manual (not defineFeature) because it needs more than a
// ConnectionManager: the shared describe service (for failure diagnostics) and
// workspaceState (for query tabs, history and saved queries).
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ConnectionManager } from '../../../salesforce/connection';
import type { DescribeService } from '../../../services/describe/DescribeService';
import type { FeatureModule, FeatureModuleFactory } from '../../FeatureModule';
import { NO_REPLY, RouteError } from '../../FeatureModule';
import { QueryService } from './QueryService';
import { QueryStateStore, type QueryTab, type SavedQuery } from './QueryStateStore';
import { SoqlDiagnosticsService } from './SoqlDiagnosticsService';

export interface SoqlFeatureOptions {
  workspaceState: vscode.Memento;
  describeService: DescribeService;
}

export function createSoqlFeature(options: SoqlFeatureOptions): FeatureModuleFactory {
  return (connectionManager: ConnectionManager): FeatureModule => {
    const service = new QueryService(connectionManager);
    const stateStore = new QueryStateStore(options.workspaceState);
    const diagnostics = new SoqlDiagnosticsService(connectionManager, options.describeService);

    const base = path.join('dist', 'features', 'soql', 'query-editor');
    return {
      id: 'query-editor',
      tab: 'soql',
      htmlPath: path.join(base, 'view.html'),
      jsPath: path.join(base, 'view.js'),
      cssPath: path.join(base, 'view.css'),
      routes: {
        /**
         * The failure path is richer than a bare message: the verbatim Salesforce
         * error is kept, and diagnostics explaining *why* it failed (a field hidden
         * by FLS, a mistyped name…) ride alongside it on the RouteError.
         *
         * `opId` (echoed back by the dispatcher) correlates the reply with the query
         * tab that started the run; the signal comes from the same registry the
         * webview's Stop button cancels through.
         */
        query: {
          handler: async (msg, signal) => {
            const soql = msg.soql as string;
            try {
              return await service.runQuery(soql, msg.useToolingApi as boolean, signal);
            } catch (err) {
              // The webview has already dropped this run, so post nothing — and skip
              // diagnose(), which would otherwise fire two more queries at the org.
              if (signal?.aborted) return NO_REPLY;
              const message = (err as Error).message;
              throw new RouteError(message, {
                diagnostics: await diagnostics.diagnose(soql, message),
              });
            }
          },
          successType: 'queryResult',
          errorType: 'queryError',
        },
        loadQueryState: {
          handler: async () => stateStore.getState(),
          successType: 'queryStateLoaded',
          errorType: 'queryStateError',
        },
        saveQueryTabs: {
          handler: async (msg) => {
            await stateStore.saveTabs(msg.tabs as QueryTab[], msg.activeTab as number);
            return NO_REPLY; // fire-and-forget: the webview owns the authoritative copy
          },
          successType: 'queryTabsSaved',
          errorType: 'queryTabsError',
        },
        addQueryHistory: {
          handler: async (msg) => ({
            history: await stateStore.addHistory({
              query: msg.query as string,
              useToolingApi: msg.useToolingApi as boolean,
            }),
          }),
          successType: 'queryHistoryUpdated',
          errorType: 'queryHistoryError',
        },
        saveSavedQueries: {
          handler: async (msg) => ({
            savedQueries: await stateStore.saveSavedQueries(msg.savedQueries as SavedQuery[]),
          }),
          successType: 'savedQueriesUpdated',
          errorType: 'savedQueriesError',
        },
        /**
         * Writes the export to a timestamped file in the workspace root and opens it.
         * Reports through native dialogs rather than the webview, so it never replies.
         */
        exportQueryResult: {
          handler: async (msg) => {
            const format = msg.format === 'json' ? 'json' : 'csv';
            const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!root) {
              await vscode.window.showErrorMessage(
                'Open a workspace folder to export query results.',
              );
              return NO_REPLY;
            }
            try {
              // 2026-06-11T14:30:45.123Z → 20260611-143045
              const iso = new Date().toISOString().replace(/[-:]/g, '');
              const stamp = `${iso.slice(0, 8)}-${iso.slice(9, 15)}`;
              const filePath = path.join(root, `query-result-${stamp}.${format}`);
              await fs.promises.writeFile(filePath, msg.content as string, 'utf8');
              await vscode.window.showTextDocument(vscode.Uri.file(filePath));
            } catch (err) {
              await vscode.window.showErrorMessage(`Export failed: ${(err as Error).message}`);
            }
            return NO_REPLY;
          },
          successType: 'exportQueryResultDone',
          errorType: 'exportQueryResultError',
        },
      },
    };
  };
}

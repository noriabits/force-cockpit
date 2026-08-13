// SOQL feature factory. Manual (not defineFeature) because it needs more than a
// ConnectionManager: the shared describe service (for failure diagnostics) and
// workspaceState (for query tabs, history and saved queries).
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ConnectionManager } from '../../../salesforce/connection';
import type { DescribeService } from '../../../services/describe/DescribeService';
import type { LmGateway } from '../../../services/ai/types';
import type { FeatureModule, FeatureModuleFactory } from '../../FeatureModule';
import { NO_REPLY, RouteError } from '../../FeatureModule';
import { createSoqlAi } from './ai/soqlAi';
import type { LastRun } from './ai/requestMessage';
import { QueryService } from './QueryService';
import { QueryStateStore, type QueryTab, type SavedQuery } from './QueryStateStore';
import { SoqlDiagnosticsService } from './SoqlDiagnosticsService';

export interface SoqlFeatureOptions {
  workspaceState: vscode.Memento;
  describeService: DescribeService;
  /** Shared with yaml-scripts / debug-logs / ask-ai; drives the AI query generator. */
  gateway: LmGateway;
}

export function createSoqlFeature(options: SoqlFeatureOptions): FeatureModuleFactory {
  return (connectionManager: ConnectionManager): FeatureModule => {
    const service = new QueryService(connectionManager);
    const stateStore = new QueryStateStore(options.workspaceState);
    const diagnostics = new SoqlDiagnosticsService(connectionManager, options.describeService);
    const soqlAi = createSoqlAi({
      gateway: options.gateway,
      connectionManager,
      describeService: options.describeService,
      queryService: service,
      diagnostics,
    });

    // Describes and validation probes from the previous org say nothing about
    // the new one — same rationale as ask-ai resetting its thread here.
    const onConnectionChanged = () => soqlAi.reset();
    connectionManager.on('connectionChanged', onConnectionChanged);

    const base = path.join('dist', 'features', 'soql', 'query-editor');
    return {
      id: 'query-editor',
      tab: 'soql',
      htmlPath: path.join(base, 'view.html'),
      jsPath: path.join(base, 'view.js'),
      cssPath: path.join(base, 'view.css'),
      labelsPath: path.join(base, 'labels.js'),
      dispose: () => connectionManager.off('connectionChanged', onConnectionChanged),
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
         * Generates a SOQL query from a plain-language request. Streams the
         * model's reasoning and tool progress back over the shared
         * `scriptLogChunk` channel (via `onChunk`), and resolves with the
         * parsed proposal so the panel can offer "Run in new tab".
         */
        generateSoqlQuery: {
          handler: async (msg, signal, onChunk) => {
            const modelId = msg.modelId as string | undefined;
            // Fire-and-forget: losing the model pick must never fail the run.
            void stateStore.saveAiModelId(modelId ?? '');
            return await soqlAi.generate(
              {
                question: msg.question as string,
                modelId,
                // The editor's live contents ride along as context — most
                // "why doesn't this work" / "now filter by X" requests are
                // about whatever the user already has open.
                currentQuery: msg.currentQuery as string | undefined,
                currentUseToolingApi: msg.currentUseToolingApi as boolean | undefined,
                // Already sampled webview-side; buildRequestMessage caps it again.
                lastRun: msg.lastRun as LastRun | null | undefined,
              },
              signal,
              onChunk,
              ({ requestedId, usedModelName }) => {
                void vscode.window.showWarningMessage(
                  `The model "${requestedId}" is no longer available. Using "${usedModelName}" instead.`,
                );
              },
            );
          },
          successType: 'soqlAiAnswer',
          errorType: 'soqlAiError',
        },
        resetSoqlAiChat: {
          handler: async () => {
            soqlAi.reset();
            return {};
          },
          successType: 'soqlAiChatReset',
          errorType: 'soqlAiChatResetError',
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

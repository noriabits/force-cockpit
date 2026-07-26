// Debug Logs feature factory. Manual (not defineFeature) because the service
// needs more than a ConnectionManager: the shared AI gateway, describe service,
// workspace search, workspaceState and the logs directory.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ConnectionManager } from '../../../salesforce/connection';
import type { DescribeService } from '../../../services/describe/DescribeService';
import type { LmGateway, WorkspaceSearch } from '../../../services/ai/types';
import type { FeatureModule, FeatureModuleFactory } from '../../FeatureModule';
import { LogAnalyzer } from './ai/LogAnalyzer';
import { DEBUG_LEVEL_PRESETS, RECOMMENDED_PRESET_ID } from './debugLevelPresets';
import { DebugLogsService } from './DebugLogsService';
import { DebugLogsStateStore, type DebugLogsState } from './DebugLogsStateStore';
import { isEmptyByMetadata } from './parsing/logNoise';
import type { ApexLogRow, CategoryLevels, NoiseOptions, TraceLogType } from './types';

export interface DebugLogsFeatureOptions {
  workspaceState: vscode.Memento;
  describeService: DescribeService;
  gateway: LmGateway;
  workspaceSearch: WorkspaceSearch;
  /** Where "Save analysis" writes, so results show up in Utils → Logs. */
  logsPath: string;
  /** Live-reloaded from config.yaml. */
  getNoiseOptions: () => Partial<NoiseOptions> | undefined;
}

export function createDebugLogsFeature(options: DebugLogsFeatureOptions): FeatureModuleFactory {
  return (connectionManager: ConnectionManager): FeatureModule => {
    const service = new DebugLogsService(connectionManager, options.getNoiseOptions());
    const stateStore = new DebugLogsStateStore(options.workspaceState);
    const analyzer = new LogAnalyzer(
      options.gateway,
      connectionManager,
      options.describeService,
      options.workspaceSearch,
    );

    // Cached bodies belong to one org — drop them when the connection changes.
    const onConnectionChanged = () => service.clearCache();
    connectionManager.on('connectionChanged', onConnectionChanged);

    /** Rows for the current list, kept so analysis can quote the log's metadata. */
    let lastRows: ApexLogRow[] = [];

    const base = path.join('dist', 'features', 'debug-logs', 'explorer');
    return {
      id: 'debug-logs',
      tab: 'debug-logs',
      htmlPath: path.join(base, 'view.html'),
      jsPath: path.join(base, 'view.js'),
      cssPath: path.join(base, 'view.css'),
      labelsPath: path.join(base, 'labels.js'),
      dispose: () => connectionManager.off('connectionChanged', onConnectionChanged),
      routes: {
        loadDebugLogsSetup: {
          handler: async () => {
            service.setNoiseOptions(options.getNoiseOptions());
            const [currentUser, systemUsers, traceFlags] = await Promise.all([
              service.currentUser(),
              service.systemUsers(),
              service.listTraceFlags(),
            ]);
            return {
              presets: DEBUG_LEVEL_PRESETS,
              recommendedPresetId: RECOMMENDED_PRESET_ID,
              currentUser,
              systemUsers,
              traceFlags,
              state: stateStore.getState(),
            };
          },
          successType: 'debugLogsSetupLoaded',
          errorType: 'debugLogsSetupError',
        },
        loadDebugLogsState: {
          handler: async () => ({ state: stateStore.getState() }),
          successType: 'debugLogsStateLoaded',
          errorType: 'debugLogsStateError',
        },
        saveDebugLogsState: {
          handler: async (msg) => {
            await stateStore.save((msg.state ?? {}) as Partial<DebugLogsState>);
            return {};
          },
          successType: 'debugLogsStateSaved',
          errorType: 'debugLogsStateError',
        },
        loadApexLogs: {
          handler: async () => {
            const rows = await service.listLogs();
            lastRows = rows;
            const noise = service.getNoiseOptions();
            return {
              logs: rows.map((row) => ({ ...row, emptyByMetadata: isEmptyByMetadata(row, noise) })),
            };
          },
          successType: 'apexLogsLoaded',
          errorType: 'apexLogsError',
        },
        classifyApexLogs: {
          handler: async (msg) => ({
            results: await service.classifyEmptyLogs((msg.logIds as string[]) ?? []),
          }),
          successType: 'apexLogsClassified',
          errorType: 'apexLogsClassifyError',
        },
        openApexLog: {
          handler: async (msg) => {
            const logId = msg.logId as string;
            const opened = await service.openLog(logId);
            return {
              logId,
              partial: opened.partial,
              totalLines: opened.totalLines,
              header: opened.parsed.header,
              events: opened.parsed.events,
              summary: opened.parsed.summary,
              issues: opened.parsed.issues,
              tree: opened.parsed.tree,
              queryPlans: opened.parsed.queryPlans,
            };
          },
          successType: 'apexLogOpened',
          errorType: 'apexLogOpenError',
        },
        openApexLogRaw: {
          handler: async (msg) => {
            const logId = msg.logId as string;
            const body = await service.getBody(logId);
            const doc = await vscode.workspace.openTextDocument({
              content: body,
              language: 'plaintext',
            });
            await vscode.window.showTextDocument(doc);
            return {};
          },
          successType: 'openApexLogRawDone',
          errorType: 'openApexLogRawError',
        },
        deleteApexLogs: {
          handler: async (msg) => {
            const logIds = (msg.logIds as string[]) ?? [];
            if (logIds.length === 0) return { confirmed: false };
            const label = logIds.length === 1 ? 'this log' : `${logIds.length} logs`;
            const confirmed = await vscode.window.showWarningMessage(
              `Delete ${label} from the org? This cannot be undone.`,
              { modal: true },
              'Delete',
            );
            if (confirmed !== 'Delete') return { confirmed: false };
            const { deleted, failed } = await service.deleteLogs(logIds);
            return { confirmed: true, deleted, failed };
          },
          successType: 'apexLogsDeleted',
          errorType: 'apexLogsDeleteError',
        },
        notifyApexLogFailure: {
          handler: async (msg) => {
            const operation = (msg.operation as string) || 'A transaction';
            const status = (msg.status as string) || 'failed';
            void vscode.window.showWarningMessage(`${operation} failed — ${status}`);
            return {};
          },
          successType: 'notifyApexLogFailureDone',
          errorType: 'notifyApexLogFailureError',
        },
        searchTraceEntities: {
          handler: async (msg) => ({
            entities: await service.searchEntities(
              (msg.term as string) ?? '',
              (msg.kind as 'user' | 'apex') ?? 'user',
            ),
            kind: (msg.kind as string) ?? 'user',
          }),
          successType: 'traceEntitiesFound',
          errorType: 'traceEntitiesError',
        },
        loadTraceFlags: {
          handler: async () => ({ traceFlags: await service.listTraceFlags() }),
          successType: 'traceFlagsLoaded',
          errorType: 'traceFlagsError',
        },
        loadDebugLevels: {
          handler: async () => ({ debugLevels: await service.listDebugLevels() }),
          successType: 'debugLevelsLoaded',
          errorType: 'debugLevelsError',
        },
        startTraceFlag: {
          handler: async (msg) => {
            const result = await service.startTrace({
              entityId: msg.entityId as string,
              logType: (msg.logType as TraceLogType) ?? 'USER_DEBUG',
              durationMs: msg.durationMs as number,
              presetId: msg.presetId as string | undefined,
              debugLevelId: msg.debugLevelId as string | undefined,
              customLevels: msg.customLevels as CategoryLevels | undefined,
            });
            return { ...result, traceFlags: await service.listTraceFlags() };
          },
          successType: 'traceFlagStarted',
          errorType: 'traceFlagError',
        },
        extendTraceFlag: {
          handler: async (msg) => {
            await service.extendTrace(msg.flagId as string, msg.durationMs as number);
            return { traceFlags: await service.listTraceFlags() };
          },
          successType: 'traceFlagExtended',
          errorType: 'traceFlagError',
        },
        stopTraceFlag: {
          handler: async (msg) => {
            await service.stopTrace(msg.flagId as string);
            return { traceFlags: await service.listTraceFlags() };
          },
          successType: 'traceFlagStopped',
          errorType: 'traceFlagError',
        },
        analyzeApexLog: {
          handler: async (msg, signal, onChunk) => {
            const logId = msg.logId as string;
            const opened = await service.openLog(logId);
            const row = lastRows.find((r) => r.id === logId) ?? null;
            const state = stateStore.getState();
            const result = await analyzer.analyze(
              {
                opened,
                row,
                question: msg.question as string | undefined,
                modelId: (msg.modelId as string) ?? state.modelId,
                allowWorkspaceFiles: (msg.allowWorkspaceFiles as boolean) ?? true,
                allowOrgQueries: (msg.allowOrgQueries as boolean) ?? false,
              },
              signal,
              onChunk,
              ({ requestedId, usedModelName }) => {
                void vscode.window.showWarningMessage(
                  `The model "${requestedId}" is no longer available. Using "${usedModelName}" instead.`,
                );
              },
            );
            return { logId, ...result };
          },
          successType: 'apexLogAnalyzed',
          errorType: 'apexLogAnalyzeError',
        },
        saveApexLogAnalysis: {
          handler: async (msg) => {
            const logId = msg.logId as string;
            const content = (msg.content as string) ?? '';
            fs.mkdirSync(options.logsPath, { recursive: true });
            const file = path.join(options.logsPath, `apexlog-${logId}-analysis.md`);
            fs.writeFileSync(file, content, 'utf8');
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
            await vscode.window.showTextDocument(doc);
            return { file };
          },
          successType: 'apexLogAnalysisSaved',
          errorType: 'apexLogAnalysisSaveError',
        },
      },
    };
  };
}

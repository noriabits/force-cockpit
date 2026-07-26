// "Ask the AI" feature factory (Overview tab). Manual (not defineFeature)
// because the service needs more than a ConnectionManager: the shared AI
// gateway, describe service, workspace search and Agent Skills repository —
// all built once in extension.ts and shared with yaml-scripts / debug-logs.
import * as path from 'path';
import * as vscode from 'vscode';
import type { ConnectionManager } from '../../../salesforce/connection';
import type { DescribeService } from '../../../services/describe/DescribeService';
import type { LmGateway, WorkspaceSearch } from '../../../services/ai/types';
import type { SkillsRepository } from '../../../services/skills/SkillsRepository';
import type { FeatureModule, FeatureModuleFactory } from '../../FeatureModule';
import { AskAiService } from './AskAiService';
import { AskAiStateStore, type AskAiState } from './AskAiStateStore';

export interface AskAiFeatureOptions {
  workspaceState: vscode.Memento;
  describeService: DescribeService;
  gateway: LmGateway;
  workspaceSearch: WorkspaceSearch;
  skillsRepo: SkillsRepository;
}

export function createAskAiFeature(options: AskAiFeatureOptions): FeatureModuleFactory {
  return (connectionManager: ConnectionManager): FeatureModule => {
    const service = new AskAiService(
      options.gateway,
      connectionManager,
      options.describeService,
      options.skillsRepo,
      options.workspaceSearch,
    );
    const stateStore = new AskAiStateStore(options.workspaceState);

    // Prior tool results (SOQL rows, describe calls) describe the org that was
    // connected when they ran — a switch (either edge) invalidates the whole
    // thread, same rationale as DebugLogsService clearing its log body cache.
    const onConnectionChanged = () => service.reset();
    connectionManager.on('connectionChanged', onConnectionChanged);

    const base = path.join('dist', 'features', 'overview', 'ask-ai');
    return {
      id: 'ask-ai',
      tab: 'overview',
      htmlPath: path.join(base, 'view.html'),
      jsPath: path.join(base, 'view.js'),
      cssPath: path.join(base, 'view.css'),
      labelsPath: path.join(base, 'labels.js'),
      dispose: () => connectionManager.off('connectionChanged', onConnectionChanged),
      routes: {
        askAiQuestion: {
          handler: async (msg, signal, onChunk) => {
            const state = stateStore.getState();
            const result = await service.ask(
              {
                question: msg.question as string,
                modelId: (msg.modelId as string) ?? state.modelId,
                access: {
                  allowWorkspaceFiles:
                    (msg.allowWorkspaceFiles as boolean) ?? state.allowWorkspaceFiles,
                  allowOrgQueries: (msg.allowOrgQueries as boolean) ?? state.allowOrgQueries,
                },
              },
              signal,
              onChunk,
              ({ requestedId, usedModelName }) => {
                void vscode.window.showWarningMessage(
                  `The model "${requestedId}" is no longer available. Using "${usedModelName}" instead.`,
                );
              },
            );
            return result;
          },
          successType: 'askAiAnswer',
          errorType: 'askAiError',
        },
        resetAskAiChat: {
          handler: async () => {
            service.reset();
            return {};
          },
          successType: 'askAiChatReset',
          errorType: 'askAiChatResetError',
        },
        loadAskAiState: {
          handler: async () => ({ state: stateStore.getState() }),
          successType: 'askAiStateLoaded',
          errorType: 'askAiStateError',
        },
        saveAskAiState: {
          handler: async (msg) => {
            const state = await stateStore.save(msg.patch as Partial<AskAiState>);
            return { state };
          },
          successType: 'askAiStateSaved',
          errorType: 'askAiStateError',
        },
      },
    };
  };
}

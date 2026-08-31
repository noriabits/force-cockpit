// "Ask the AI" feature factory (Overview tab). The shared AI gateway, describe
// service, workspace search and Agent Skills repository all come from the
// FeatureContext — built once in extension.ts, shared with yaml-scripts and
// debug-logs.
import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import type { FeatureModuleFactory } from '../../FeatureModule';
import { AskAiHistoryStore } from './AskAiHistoryStore';
import { AskAiService } from './AskAiService';
import { createAskAiStateStore, type AskAiState } from './AskAiStateStore';
import { deriveTitleFromMessages, reconstructTranscript } from './reconstructTranscript';

export const askAiFeature: FeatureModuleFactory = (ctx) => {
  const { connectionManager } = ctx;
  const service = new AskAiService(
    ctx.gateway,
    connectionManager,
    ctx.describeService,
    ctx.skillsRepo,
    ctx.workspaceSearch,
  );
  const stateStore = createAskAiStateStore(ctx.workspaceState);
  // Workspace-scoped and global across orgs — same base path the shared
  // DescribeDiskCache is built from.
  const historyStore = new AskAiHistoryStore(path.join(ctx.paths.user, '.ask-ai-history'));

  // The id of the History entry the live conversation is saved under, or
  // null before its first completed reply. Stable for the life of a
  // session — every subsequent successful turn upserts the SAME entry
  // (AskAiHistoryStore.save() replaces any existing entry with this id
  // rather than appending a new one), so a multi-turn conversation always
  // shows as one History row, not one per question.
  let currentConversationId: string | null = null;

  // Persists the live thread right after a completed reply — this is the
  // only place a History entry is written. Deliberately NOT tied to
  // "New chat" / connection changes / the panel closing: by the time any of
  // those fire, everything the user has actually seen is already saved, so
  // there's nothing left to archive at session-end. Title/transcript are
  // always reconstructed host-side from the raw thread (see
  // reconstructTranscript.ts) rather than asked of the webview, since this
  // needs to run after every turn, not just once at the end of a session.
  const saveCurrentConversation = () => {
    const snapshot = service.getSnapshot();
    if (!snapshot) return;
    currentConversationId ??= crypto.randomUUID();
    historyStore.save({
      id: currentConversationId,
      title: deriveTitleFromMessages(snapshot.messages),
      updatedAt: Date.now(),
      modelId: snapshot.modelId,
      transcript: reconstructTranscript(snapshot.messages),
      // AiConversation mutates `messages` in place — clone before it can change again.
      messages: JSON.parse(JSON.stringify(snapshot.messages)),
      messagesTruncated: false, // store enforces the cap and flips this if needed
      locked: snapshot.locked,
      turns: snapshot.turns,
    });
  };

  // Prior tool results (SOQL rows, describe calls) describe the org that was
  // connected when they ran — a switch (either edge) invalidates the whole
  // thread, same rationale as DebugLogsService clearing its log body cache.
  // Nothing to save here: every reply up to this point was already
  // persisted by saveCurrentConversation() as it happened.
  const onConnectionChanged = () => {
    service.reset();
    currentConversationId = null;
  };
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
          // A cancelled turn is rolled back by AskAiService — nothing new
          // was actually added to the thread, so there's nothing to save.
          if (!result.cancelled) {
            saveCurrentConversation();
          }
          return result;
        },
        successType: 'askAiAnswer',
        errorType: 'askAiError',
      },
      resetAskAiChat: {
        handler: async () => {
          service.reset();
          currentConversationId = null;
          return {};
        },
        successType: 'askAiChatReset',
        errorType: 'askAiChatResetError',
      },
      loadAskAiHistory: {
        handler: async () => ({ conversations: historyStore.list() }),
        successType: 'askAiHistoryLoaded',
        errorType: 'askAiHistoryError',
      },
      loadAskAiConversation: {
        handler: async (msg) => {
          const id = msg.id as string;
          const conversation = historyStore.get(id);
          if (!conversation) {
            throw new Error('Conversation not found.');
          }
          if (conversation.messagesTruncated) {
            // The raw thread didn't fit the store's size cap — nothing to
            // resume with, so start clean; the transcript still shows in
            // full. A follow-up question here starts a brand-new entry
            // rather than appending to this one, since there's no thread
            // left to continue.
            service.reset();
            currentConversationId = null;
          } else {
            service.restoreSnapshot({
              messages: conversation.messages,
              locked: conversation.locked,
              turns: conversation.turns,
              modelId: conversation.modelId,
            });
            // A follow-up question continues updating THIS entry.
            currentConversationId = conversation.id;
          }
          return {
            transcript: conversation.transcript,
            modelId: conversation.modelId,
            messagesTruncated: conversation.messagesTruncated,
          };
        },
        successType: 'askAiConversationLoaded',
        errorType: 'askAiConversationLoadedError',
      },
      deleteAskAiConversation: {
        handler: async (msg) => {
          const id = msg.id as string;
          historyStore.remove(id);
          if (id === currentConversationId) {
            // The live session's own entry was deleted from under it — the
            // next completed reply should start a fresh entry, not resurrect
            // the deleted one under the same id.
            currentConversationId = null;
          }
          return { id };
        },
        successType: 'askAiConversationDeleted',
        errorType: 'askAiConversationDeleteError',
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

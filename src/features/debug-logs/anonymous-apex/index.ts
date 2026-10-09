// ▶️ Apex — ad-hoc Execute Anonymous with tabs, history and the parsed log.
//
// A TOP-LEVEL tab whose source lives under debug-logs/: `tab: 'apex'` picks the
// `<!-- features:apex -->` placeholder in main.html, while `dir: 'debug-logs'`
// keeps the built assets beside the Debug Logs explorer, where
// copy-feature-assets writes them. It sits here because it reuses that
// explorer's parsing pipeline, debug-level presets and log viewer wholesale, and
// this repo has no feature-to-feature imports — a sibling folder is the same
// domain, not a second feature reaching into the first.
//
// Stateless on the host apart from the persisted tabs/history: a run's outcome
// lives in the webview tab that started it.
import type { ApexSnippet, ApexTab, SavedApexSnippet } from '../../../shared/protocol';
import { NO_REPLY } from '../../FeatureModule';
import { defineFeature } from '../../defineFeature';
import type { FeatureContext } from '../../FeatureContext';
import { AnonymousApexService } from './AnonymousApexService';
import { ApexStateStore } from './ApexStateStore';

function build(ctx: FeatureContext) {
  return {
    service: new AnonymousApexService(ctx.connectionManager),
    store: new ApexStateStore(ctx.workspaceState),
  };
}

export const anonymousApexFeature = defineFeature({
  id: 'anonymous-apex',
  tab: 'apex',
  dir: 'debug-logs',
  create: build,
  routes: ({ service, store }) => ({
    loadApexState: {
      handler: async () => store.getState(),
      successType: 'apexStateLoaded',
      errorType: 'apexStateError',
    },
    saveApexTabs: {
      handler: async (msg) => {
        await store.saveTabs(msg.tabs as ApexTab[], msg.activeTab as number);
        return NO_REPLY; // fire-and-forget: the webview owns the authoritative copy
      },
      successType: 'apexTabsSaved',
      errorType: 'apexTabsError',
    },
    saveApexPreset: {
      handler: async (msg) => {
        await store.savePreset(msg.presetId as string);
        return NO_REPLY;
      },
      successType: 'apexPresetSaved',
      errorType: 'apexPresetError',
    },
    addApexHistory: {
      handler: async (msg) => ({
        history: await store.addHistory({ code: msg.code as string } satisfies ApexSnippet),
      }),
      successType: 'apexHistoryUpdated',
      errorType: 'apexHistoryError',
    },
    saveApexSavedSnippets: {
      handler: async (msg) => ({
        savedSnippets: await store.saveSavedSnippets(msg.savedSnippets as SavedApexSnippet[]),
      }),
      successType: 'apexSavedSnippetsUpdated',
      errorType: 'apexSavedSnippetsError',
    },
    executeAnonymousApex: {
      handler: async (msg, signal) => {
        try {
          return await service.execute(msg.code as string, msg.presetId as string, signal);
        } catch (err) {
          // A cancelled run posts nothing: the webview has already dropped it.
          if (signal?.aborted) return NO_REPLY;
          throw err;
        }
      },
      successType: 'anonymousApexExecuted',
      errorType: 'anonymousApexError',
    },
  }),
});

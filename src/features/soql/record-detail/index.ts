// Record Detail — the SOQL tab's second sub-tab (⚡ Query | 🔎 Record
// Detail). Shows one record per tab with every field the user can read and saves
// inline edits as a PATCH of only the changed fields.
//
// `tab: 'soql-record-detail'` picks the sub-tab's own placeholder in main.html;
// `dir: 'soql'` keeps the built assets beside the query editor's, where
// copy-feature-assets puts them (see defineFeature's `dir`).
//
// The only host state is the persisted record tabs, kept PER ORG (a record Id
// means nothing in another org) — a run's outcome lives in the webview tab that
// started it, and nothing here needs resetting on `connectionChanged`.
import { FieldAccessService } from '../../../services/permissions/FieldAccessService';
import { RestCallService } from '../../../services/rest/RestCallService';
import type { RecordDetailTab } from '../../../shared/protocol';
import { NO_REPLY } from '../../FeatureModule';
import { defineFeature } from '../../defineFeature';
import type { FeatureContext } from '../../FeatureContext';
import { RecordDetailService } from './RecordDetailService';
import { RecordDetailStateStore } from './RecordDetailStateStore';

function buildRecordDetail(ctx: FeatureContext) {
  const { connectionManager } = ctx;
  return {
    service: new RecordDetailService(
      ctx.describeService,
      new RestCallService(connectionManager),
      new FieldAccessService(connectionManager),
      () => connectionManager.apiVersion,
    ),
    store: new RecordDetailStateStore(ctx.workspaceState),
    currentOrgId: () => connectionManager.getCurrentOrg()?.orgId ?? null,
  };
}

/** A cancelled run posts nothing: the webview has already dropped it. */
async function unlessAborted<T>(run: () => Promise<T>, signal?: AbortSignal) {
  try {
    return await run();
  } catch (err) {
    if (signal?.aborted) return NO_REPLY;
    throw err;
  }
}

export const recordDetailFeature = defineFeature({
  id: 'record-detail',
  tab: 'soql-record-detail',
  dir: 'soql',
  create: buildRecordDetail,
  routes: ({ service, store, currentOrgId }) => ({
    loadRecordDetail: {
      handler: (msg, signal) =>
        unlessAborted(() => service.load(msg.recordId as string, signal), signal),
      successType: 'recordDetailLoaded',
      errorType: 'loadRecordDetailError',
    },
    saveRecordChanges: {
      handler: (msg, signal) =>
        unlessAborted(
          () =>
            service.save(
              msg.objectName as string,
              msg.recordId as string,
              (msg.changes ?? {}) as Record<string, unknown>,
              signal,
            ),
          signal,
        ),
      successType: 'recordChangesSaved',
      errorType: 'saveRecordChangesError',
    },
    loadRecordDetailState: {
      // Stamped with the org it describes, so the webview can drop a reply that
      // arrives after yet another org switch.
      handler: async () => store.getState(currentOrgId()),
      successType: 'recordDetailStateLoaded',
      errorType: 'recordDetailStateError',
    },
    saveRecordDetailTabs: {
      handler: async (msg) => {
        await store.saveTabs(
          msg.orgId as string | undefined,
          msg.tabs as RecordDetailTab[],
          msg.activeTab as number,
        );
        return NO_REPLY; // fire-and-forget: the webview owns the authoritative copy
      },
      successType: 'recordDetailTabsSaved',
      errorType: 'recordDetailTabsError',
    },
  }),
});

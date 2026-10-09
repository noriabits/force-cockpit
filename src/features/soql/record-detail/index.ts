// Record Detail — the SOQL tab's second sub-tab (⚡ Query | 🔎 Record
// Detail). Shows one record with every field the user can read and saves
// inline edits as a PATCH of only the changed fields.
//
// `tab: 'soql-record-detail'` picks the sub-tab's own placeholder in main.html;
// `dir: 'soql'` keeps the built assets beside the query editor's, where
// copy-feature-assets puts them (see defineFeature's `dir`).
//
// Stateless on the host — nothing to reset on `connectionChanged`. The webview
// clears its own record on both org edges.
import { FieldAccessService } from '../../../services/permissions/FieldAccessService';
import { RestCallService } from '../../../services/rest/RestCallService';
import { NO_REPLY } from '../../FeatureModule';
import { defineFeature } from '../../defineFeature';
import type { FeatureContext } from '../../FeatureContext';
import { RecordDetailService } from './RecordDetailService';

function buildRecordDetail(ctx: FeatureContext): RecordDetailService {
  const { connectionManager } = ctx;
  return new RecordDetailService(
    ctx.describeService,
    new RestCallService(connectionManager),
    new FieldAccessService(connectionManager),
    () => connectionManager.apiVersion,
  );
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
  routes: (service) => ({
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
  }),
});

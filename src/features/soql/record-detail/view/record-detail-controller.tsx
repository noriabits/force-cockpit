// Everything in the Record Detail that is not rendering: the record tabs, run
// tracking, the edit → review → save flow, and the host reply handlers. No JSX —
// this is the seam the component test drives.
//
// ONE RECORD PER TAB, through the shared tab strip (shared/view/tab-strip.js), so
// two related records can be open at once and following a lookup no longer
// replaces what is on screen. That is what retired the ← Back stack: the record
// you came from is still a tab.
//
// Per-tab state is held on the tab OBJECT — the loaded record (`results`, the
// strip's own slot), plus this feature's `idDraft` / `edits` / `review` /
// `filter` / `notice` / `runKind`. The signal bag below is a MIRROR of whichever
// tab is active, written by `paint` (the REST tab's `runningOpId` mirror is the
// precedent: the strip's tab list is a plain array, not reactive, so every site
// that changes what is visible has to call `paint`).
//
// Run tracking is the shared tab runner (shared/view/tab-runner.ts), as in the
// REST and ▶️ Apex tabs: a reply lands in the tab that asked for it, and a
// closed or cancelled tab's reply is dropped. opIds are `detail-N`, disjoint from
// `op-N`, `soql-N`, `rest-N`, `apex-N` and `plugin-N`.
//
// STATE is a factory-made signal bag, not `useSignal`: the strip, the host
// handlers and `win.__showRecordDetail` (the SOQL results' 🔍) all run outside
// any render.
import { batch, computed, signal } from '@preact/signals';
import { post } from '../../../shared/view/host';
import type {
  HostMessage,
  RecordDetailData,
  RecordDetailState as PersistedState,
  LoadRecordDetailMessage,
  SaveRecordChangesMessage,
} from '../../../../shared/protocol';
import { createTabStrip } from '../../../shared/view/tab-strip';
import { createTabRunner } from '../../../shared/view/tab-runner';
import { buildChanges, type RawValue } from './record-edits';
import { dirtyCountOf, recordBaseName, sameRecordId } from './record-tab-name';

interface CockpitWindow {
  __vscode: { postMessage: (msg: unknown) => void };
  __orgConnected?: boolean;
  __currentOrg?: { orgId?: string } | null;
  __confirmIfSensitive: (org: unknown, label: string, onConfirmed: () => void) => void;
  __confirmAction: (prompt: string, onConfirmed: () => void) => void;
  RecordDetailLabels: Record<string, string>;
}
const win = () => window as unknown as CockpitWindow;
const L = () => win().RecordDetailLabels;

type Review = ReturnType<typeof buildChanges>['review'];

/** One record tab: the persisted payload, the strip's slots, and this tab's own UI state. */
interface DetailTab {
  /** 18-char Id once loaded, whatever was typed before that, '' for a blank tab. Persisted. */
  recordId: string;
  name: string;
  autoName: boolean;
  nameObject: string | null;
  /** Strip slots: the loaded record and the last failure. In-memory. */
  results: RecordDetailData | null;
  error: string | null;
  opId: string | null;
  /**
   * This tab's own in-memory UI state. OPTIONAL because the strip builds a tab
   * from `newPayload`/`payloadOf` and knows nothing of these — a tab restored,
   * cloned or spliced in has them unset until it is used, so every read below
   * carries its own default rather than a normalisation pass nothing enforces.
   */
  idDraft?: string;
  edits?: Record<string, RawValue>;
  review?: Review | null;
  filter?: string;
  notice?: string;
  /** Which signal the in-flight run mirrors. */
  runKind?: 'load' | 'save' | null;
}

export function createRecordDetailState() {
  return {
    idInput: signal(''),
    record: signal<RecordDetailData | null>(null),
    filter: signal(''),
    edits: signal<Record<string, RawValue>>({}),
    /** Non-null while the review diff is on screen. */
    review: signal<Review | null>(null),
    loadingOpId: signal<string | null>(null),
    savingOpId: signal<string | null>(null),
    error: signal(''),
    notice: signal(''),
  };
}
export type RecordDetailState = ReturnType<typeof createRecordDetailState>;

export function createRecordDetailController(state: RecordDetailState) {
  const vscode = { postMessage: (msg: unknown) => win().__vscode.postMessage(msg) };
  let tabs: ReturnType<typeof createTabStrip>;
  /**
   * The org whose tabs the strip is holding, once its state has been loaded.
   * Null until then, and every persist before that carries no orgId — which the
   * host ignores, so a blank strip can never overwrite an org's saved tabs.
   */
  let hydratedFor: string | null = null;

  const runs = createTabRunner<DetailTab, unknown>({ tabs: () => tabs, vscode, prefix: 'detail' });

  const dirtyCount = computed(() => dirtyCountOf(state.record.value, state.edits.value));

  const currentOrgId = () => win().__currentOrg?.orgId ?? null;
  const activeTab = () => tabs.getActive() as DetailTab | undefined;

  /** Mirror `tab` into the signal bag. A no-op for a tab that is not on screen. */
  function paint(tab: DetailTab | undefined) {
    if (!tab || tab !== activeTab()) return;
    batch(() => {
      state.idInput.value = tab.idDraft ?? tab.recordId;
      state.record.value = tab.results;
      state.edits.value = tab.edits ?? {};
      state.review.value = tab.review ?? null;
      state.filter.value = tab.filter ?? '';
      state.error.value = tab.error ?? '';
      state.notice.value = tab.notice ?? '';
      state.loadingOpId.value = tab.runKind === 'load' ? tab.opId : null;
      state.savingOpId.value = tab.runKind === 'save' ? tab.opId : null;
    });
  }

  /** Write fields onto the active tab and re-mirror it. */
  function patchActive(changes: Partial<DetailTab>) {
    const tab = activeTab();
    if (!tab) return;
    Object.assign(tab, changes);
    paint(tab);
  }

  function loadTab(tab: DetailTab) {
    const recordId = tab.recordId.trim();
    if (!recordId) return;
    Object.assign(tab, { runKind: 'load', edits: {}, review: null, notice: '', idDraft: recordId });
    // `start` clears the tab's previous record and failure (settleRun), so the
    // record on screen goes the moment another is asked for — leaving it up would
    // show the PREVIOUS record, values and editors under the new request.
    runs.start(tab, recordId, (opId) =>
      post<LoadRecordDetailMessage>({ type: 'loadRecordDetail', opId, recordId }),
    );
    paint(tab);
  }

  /**
   * Load a tab that holds a record but has nothing to show — a tab restored from
   * the previous session, or one just opened. Silent while disconnected and
   * never re-fetches, so restoring twenty tabs fires no burst of requests: each
   * loads when it is first activated.
   */
  function maybeLoad(tab: DetailTab | undefined) {
    if (!tab || tab.results || tab.error || tab.opId) return;
    if (!tab.recordId.trim() || !win().__orgConnected) return;
    loadTab(tab);
  }

  /**
   * Unsaved edits are never discarded silently — the two paths that really
   * discard them (re-loading this tab's record, closing the tab) ask first.
   * Opening ANOTHER record asks nothing: the edits stay in their own tab.
   */
  function guardUnsaved(tab: DetailTab, go: () => void, prompt = L().confirmDiscard) {
    if (dirtyCountOf(tab.results, tab.edits ?? {}) > 0) win().__confirmAction(prompt, go);
    else go();
  }

  /**
   * Open a record: the Show button / Enter in the Id box, the SOQL results' 🔍,
   * and a lookup link. A record some tab already holds is FOCUSED rather than
   * opened a second time (15-char Ids normalised first); re-opening the record
   * already on screen re-fetches it. Otherwise it lands in its own tab — reusing
   * the active one only while that is still blank.
   */
  function open(rawId: string) {
    const recordId = (rawId || '').trim();
    if (!recordId) return void patchActive({ error: L().errorNoId });
    if (!win().__orgConnected) return void patchActive({ error: L().errorNotConnected });
    const existing = tabs.findIndex((t: DetailTab) => sameRecordId(t.recordId, recordId));
    if (existing >= 0) {
      tabs.switchTo(existing);
      const tab = activeTab();
      if (!tab) return;
      // switchTo is a no-op when that tab is already active, so its load (or
      // re-load) is asked for here rather than left to `onActivate`.
      if (tab.results || tab.error) guardUnsaved(tab, () => loadTab(tab));
      else maybeLoad(tab);
      paint(tab);
      return;
    }
    // onActivate → maybeLoad starts the load for the tab this lands in.
    tabs.openTab({ payload: { recordId } });
  }

  function setEdit(name: string, raw: RawValue) {
    const tab = activeTab();
    if (!tab) return;
    patchActive({ edits: { ...(tab.edits ?? {}), [name]: raw } });
  }

  function discardEdits() {
    patchActive({ edits: {}, review: null, error: null });
  }

  /** Validate and show the before → after diff; nothing is sent yet. */
  function startReview() {
    const tab = activeTab();
    const rec = tab?.results;
    if (!tab || !rec) return;
    const { review, errors } = buildChanges(rec.fields, rec.values, tab.edits ?? {});
    patchActive({
      notice: '',
      error: errors.join('\n') || null,
      review: errors.length || review.length === 0 ? null : review,
    });
  }

  /**
   * Send the PATCH. The tab and the changes are captured NOW, before the
   * sensitive-org confirm: that modal is asynchronous, and by the time it is
   * answered the user may have switched tabs or edited another record.
   */
  function confirmSave() {
    const tab = activeTab();
    const rec = tab?.results;
    if (!tab || !rec) return;
    const { changes, errors } = buildChanges(rec.fields, rec.values, tab.edits ?? {});
    if (errors.length || Object.keys(changes).length === 0) return startReview();
    if (!win().__orgConnected) return void patchActive({ error: L().errorNotConnected });
    const count = Object.keys(changes).length;
    win().__confirmIfSensitive(
      win().__currentOrg,
      L().confirmSave.replace('{n}', String(count)),
      () => {
        Object.assign(tab, { runKind: 'save', error: null, notice: '' });
        // keepOutcome: a save runs against the record being looked at, so the
        // record stays on screen for the round trip instead of blanking.
        runs.start(
          tab,
          changes,
          (opId) =>
            post<SaveRecordChangesMessage>({
              type: 'saveRecordChanges',
              opId,
              objectName: rec.objectName,
              recordId: rec.id,
              changes,
            }),
          { keepOutcome: true },
        );
        paint(tab);
      },
    );
  }

  /** ✕ Cancel: stop whatever the active tab is doing. */
  function cancel() {
    const tab = activeTab();
    const opId = tabs.getActiveOpId();
    if (!tab || !opId) return;
    runs.stop(opId);
    tabs.setActiveOpId(null, tab);
    tab.runKind = null;
    paint(tab);
  }

  /** Org edges and `cancelAllOperations`: every reply in flight belonged to the old org. */
  function stopAllRuns() {
    runs.stopAll();
    paint(activeTab());
  }

  /** Both org edges: the tabs belong to the org that is gone. Connect also re-hydrates. */
  function resetForOrg(connected: boolean) {
    runs.stopAll();
    hydratedFor = null;
    tabs.load({});
    if (connected) post({ type: 'loadRecordDetailState' });
  }

  function attach(els: { tabBarEl: HTMLElement }) {
    tabs = createTabStrip({
      tabBarEl: els.tabBarEl,
      vscode,
      persistType: 'saveRecordDetailTabs',
      addTooltip: L().newTabTooltip,
      newPayload: () => ({ recordId: '' }),
      payloadOf: (record: { recordId?: unknown }) => ({
        recordId: typeof record.recordId === 'string' ? record.recordId : '',
      }),
      // The Id box is a per-tab DRAFT, not the payload: what a tab holds is the
      // record it loaded, not whatever is half-typed in the box. `paint` writes
      // the box from the tab, and `setIdDraft` writes the tab from the box.
      readUI: () => ({}),
      writeUI: () => {},
      baseNameFor: (tab: DetailTab) => recordBaseName(tab, L().blankTabName),
      isPristine: (tab: DetailTab) => !tab.recordId.trim(),
      onActivate: (tab: DetailTab) => {
        maybeLoad(tab);
        paint(tab);
      },
      onTabClosed: (tab: DetailTab) => runs.stop(tab.opId),
      beforeClose: (tab: DetailTab, proceed: () => void) =>
        guardUnsaved(tab, proceed, L().confirmCloseDirty),
      persistContext: () => (hydratedFor ? { orgId: hydratedFor } : {}),
    });
  }

  /** The host reply handlers, registered by index.tsx once the tree is mounted. */
  const handlers = {
    recordDetailLoaded(msg: HostMessage<RecordDetailData & { opId?: string }>) {
      const owner = runs.claim(msg);
      const rec = msg.data;
      if (!owner || !rec) return;
      const { tab } = owner;
      tabs.settleRun(tab, rec, null);
      Object.assign(tab, {
        recordId: rec.id,
        idDraft: rec.id,
        edits: {},
        review: null,
        filter: '',
        notice: '',
        runKind: null,
      });
      // The name is only knowable now — a record tab is named after its record.
      tabs.refreshName(tab);
      tabs.persist();
      paint(tab);
    },
    loadRecordDetailError(msg: HostMessage<{ opId?: string; message?: string }>) {
      const owner = runs.claim(msg);
      if (!owner) return;
      const { tab } = owner;
      tabs.settleRun(tab, null, msg.data?.message ?? L().errorUnknown);
      tab.runKind = null;
      tabs.refreshName(tab);
      paint(tab);
    },
    recordChangesSaved(msg: HostMessage<RecordDetailData & { opId?: string }>) {
      const owner = runs.claim(msg);
      const rec = msg.data;
      if (!owner || !rec) return;
      const { tab } = owner;
      tabs.settleRun(tab, rec, null);
      Object.assign(tab, {
        edits: {},
        review: null,
        notice: L().saved,
        runKind: null,
      });
      // A saved change to the name field renames the tab.
      tabs.refreshName(tab);
      tabs.persist();
      paint(tab);
    },
    /** Salesforce's own message, verbatim; the edits stay so they can be fixed. */
    saveRecordChangesError(msg: HostMessage<{ opId?: string; message?: string }>) {
      const owner = runs.claim(msg);
      if (!owner) return;
      const { tab } = owner;
      tabs.settleRun(tab, tab.results, msg.data?.message ?? L().errorUnknown);
      Object.assign(tab, { review: null, runKind: null });
      paint(tab);
    },
    /**
     * This org's persisted tabs. A reply for an org that is no longer connected
     * is dropped — the user switched again while it was in flight. Tabs the user
     * has already opened win over the stored set: hydration would discard a load
     * they just asked for, and the next persist writes what they have instead.
     */
    recordDetailStateLoaded(msg: HostMessage<PersistedState>) {
      const data = msg.data;
      if (!data?.orgId || data.orgId !== currentOrgId()) return;
      hydratedFor = data.orgId;
      const started = tabs.findIndex((t: DetailTab) => !!t.recordId.trim() || !!t.opId) >= 0;
      if (started) return void tabs.persist();
      tabs.load({ tabs: data.tabs, activeTab: data.activeTab });
    },
    cancelAllOperations: () => stopAllRuns(),
  };

  return {
    attach,
    handlers,
    dirtyCount,
    /** Show / Enter in the Id box. */
    showInput: () => open(state.idInput.value),
    /** The SOQL results' 🔍 and a lookup link — both open the record in a tab. */
    open,
    // Editing the Id drops the tab's last message: a 404 for the Id that was
    // there is not about the one being typed, and an error left standing would
    // also make a blank tab non-pristine, so the Id just typed into it would
    // open in a second tab instead of this one.
    setIdDraft: (value: string) => patchActive({ idDraft: value, error: null, notice: '' }),
    setFilter: (value: string) => patchActive({ filter: value }),
    setEdit,
    discardEdits,
    backToEditing: () => patchActive({ review: null }),
    startReview,
    confirmSave,
    cancel,
    cloneActiveTab: () => tabs.cloneActive(),
    onOrgConnected: () => resetForOrg(true),
    onOrgDisconnected: () => resetForOrg(false),
  };
}
export type RecordDetailController = ReturnType<typeof createRecordDetailController>;

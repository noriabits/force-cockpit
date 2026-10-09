// Everything in the Record Detail that is not rendering: the signal bag, run
// tracking, navigation (the back stack), the edit → review → save flow, and the
// host reply handlers. No JSX — this is the seam the component test drives.
//
// RUN TRACKING is hand-rolled, as in the REST tab, rather than going through
// `win.__startAction`: that helper writes `disabled` onto a button and inserts
// a ✕ Cancel sibling into its parent, both of which Preact owns here. So this
// mints its own opIds (`detail-N`, disjoint from `op-N`, `soql-N`, `rest-N` and
// `plugin-N`), posts `operationStarted`/`operationEnded` itself — which is what
// makes an org switch mid-load warn first — and renders Cancel declaratively.
// At most one run is in flight; a reply whose opId is not the current one is
// dropped, so a cancelled or superseded load can never paint.
//
// STATE is a factory-made signal bag, not `useSignal`: the host handlers and
// `win.__showRecordDetail` (the SOQL results' 🔍) run outside any render.
import { batch, computed, signal } from '@preact/signals';
import { post } from '../../../shared/view/host';
import type {
  HostMessage,
  RecordDetailData,
  LoadRecordDetailMessage,
  SaveRecordChangesMessage,
} from '../../../../shared/protocol';
import { buildChanges, isDirty, type RawValue } from './record-edits';

interface CockpitWindow {
  __orgConnected?: boolean;
  __currentOrg?: unknown;
  __confirmIfSensitive: (org: unknown, label: string, onConfirmed: () => void) => void;
  __confirmAction: (prompt: string, onConfirmed: () => void) => void;
  RecordDetailLabels: Record<string, string>;
}
const win = () => window as unknown as CockpitWindow;
const L = () => win().RecordDetailLabels;

type Review = ReturnType<typeof buildChanges>['review'];

export function createRecordDetailState() {
  return {
    idInput: signal(''),
    record: signal<RecordDetailData | null>(null),
    /** Ids of the records left behind by following a lookup, most recent last. */
    backStack: signal<string[]>([]),
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
  let opSeq = 0;
  /** For each in-flight load, the record it navigated away from (null = new trail). */
  const navFrom = new Map<string, { from: string | null; resetTrail: boolean }>();

  const dirtyCount = computed(() => {
    const rec = state.record.value;
    if (!rec) return 0;
    const edits = state.edits.value;
    return rec.fields.filter(
      (f) => f.name in edits && isDirty(f, rec.values[f.name], edits[f.name]),
    ).length;
  });

  function begin(): string {
    const opId = 'detail-' + ++opSeq;
    post({ type: 'operationStarted', opId });
    return opId;
  }

  function stop(opId: string | null) {
    if (!opId) return;
    navFrom.delete(opId);
    post({ type: 'cancelOperation', opId });
    post({ type: 'operationEnded', opId });
  }

  function cancel() {
    batch(() => {
      stop(state.loadingOpId.value);
      stop(state.savingOpId.value);
      state.loadingOpId.value = null;
      state.savingOpId.value = null;
    });
  }

  /** Unsaved edits are never discarded silently — leaving the record asks first. */
  function guardUnsaved(go: () => void) {
    if (dirtyCount.value > 0) win().__confirmAction(L().confirmDiscard, go);
    else go();
  }

  function load(rawId: string, nav: { from: string | null; resetTrail: boolean }) {
    const recordId = rawId.trim();
    if (!recordId) return void (state.error.value = L().errorNoId);
    if (!win().__orgConnected) return void (state.error.value = L().errorNotConnected);
    cancel();
    const opId = begin();
    navFrom.set(opId, nav);
    batch(() => {
      state.loadingOpId.value = opId;
      state.error.value = '';
      state.notice.value = '';
    });
    post<LoadRecordDetailMessage>({ type: 'loadRecordDetail', opId, recordId });
  }

  /** The Show button / Enter in the Id box: a fresh trail. */
  function loadInput() {
    guardUnsaved(() => load(state.idInput.value, { from: null, resetTrail: true }));
  }

  /** Follow a lookup from the record on screen: remember where we came from. */
  function follow(id: string) {
    const from = state.record.value?.id ?? null;
    guardUnsaved(() => load(id, { from, resetTrail: false }));
  }

  function back() {
    const stack = state.backStack.value;
    const prev = stack[stack.length - 1];
    if (!prev) return;
    guardUnsaved(() => {
      state.backStack.value = stack.slice(0, -1);
      load(prev, { from: null, resetTrail: false });
    });
  }

  /** Entry point from outside (the SOQL results' 🔍): a fresh trail. */
  function loadFromElsewhere(id: string) {
    guardUnsaved(() => {
      state.idInput.value = id;
      load(id, { from: null, resetTrail: true });
    });
  }

  function setEdit(name: string, raw: RawValue) {
    state.edits.value = { ...state.edits.value, [name]: raw };
  }

  function discardEdits() {
    batch(() => {
      state.edits.value = {};
      state.review.value = null;
      state.error.value = '';
    });
  }

  /** Validate and show the before → after diff; nothing is sent yet. */
  function startReview() {
    const rec = state.record.value;
    if (!rec) return;
    const { review, errors } = buildChanges(rec.fields, rec.values, state.edits.value);
    batch(() => {
      state.notice.value = '';
      state.error.value = errors.join('\n');
      state.review.value = errors.length || review.length === 0 ? null : review;
    });
  }

  /**
   * Send the PATCH. The record and the changes are captured NOW, before the
   * sensitive-org confirm: that modal is asynchronous, and by the time it is
   * answered the user may have navigated to another record.
   */
  function confirmSave() {
    const rec = state.record.value;
    if (!rec) return;
    const { changes, errors } = buildChanges(rec.fields, rec.values, state.edits.value);
    if (errors.length || Object.keys(changes).length === 0) return startReview();
    if (!win().__orgConnected) return void (state.error.value = L().errorNotConnected);
    const count = Object.keys(changes).length;
    win().__confirmIfSensitive(
      win().__currentOrg,
      L().confirmSave.replace('{n}', String(count)),
      () => {
        cancel();
        const opId = begin();
        batch(() => {
          state.savingOpId.value = opId;
          state.error.value = '';
        });
        post<SaveRecordChangesMessage>({
          type: 'saveRecordChanges',
          opId,
          objectName: rec.objectName,
          recordId: rec.id,
          changes,
        });
      },
    );
  }

  /** Org edges and cancelAllOperations: the record belongs to the org that is gone. */
  function reset() {
    cancel();
    batch(() => {
      state.record.value = null;
      state.backStack.value = [];
      state.edits.value = {};
      state.review.value = null;
      state.filter.value = '';
      state.error.value = '';
      state.notice.value = '';
    });
  }

  /** The opId a reply belongs to, if it is the run still being waited on. Always ends the op. */
  function claim(msg: HostMessage<{ opId?: string }>, current: string | null): string | null {
    const opId = msg.data?.opId;
    if (opId) post({ type: 'operationEnded', opId });
    return opId && opId === current ? opId : null;
  }

  function showRecord(rec: RecordDetailData) {
    state.record.value = rec;
    state.idInput.value = rec.id;
    state.edits.value = {};
    state.review.value = null;
    state.filter.value = '';
  }

  const handlers = {
    recordDetailLoaded(msg: HostMessage<RecordDetailData & { opId?: string }>) {
      const opId = claim(msg, state.loadingOpId.value);
      const rec = msg.data;
      if (!opId || !rec) return;
      const nav = navFrom.get(opId);
      navFrom.delete(opId);
      batch(() => {
        state.loadingOpId.value = null;
        if (nav?.resetTrail) state.backStack.value = [];
        else if (nav?.from) state.backStack.value = [...state.backStack.value, nav.from];
        showRecord(rec);
      });
    },
    loadRecordDetailError(msg: HostMessage<{ opId?: string; message?: string }>) {
      const opId = claim(msg, state.loadingOpId.value);
      if (!opId) return;
      navFrom.delete(opId);
      batch(() => {
        state.loadingOpId.value = null;
        state.error.value = msg.data?.message ?? L().errorUnknown;
      });
    },
    recordChangesSaved(msg: HostMessage<RecordDetailData & { opId?: string }>) {
      const opId = claim(msg, state.savingOpId.value);
      const rec = msg.data;
      if (!opId || !rec) return;
      batch(() => {
        state.savingOpId.value = null;
        showRecord(rec);
        state.notice.value = L().saved;
      });
    },
    /** Salesforce's own message, verbatim; the edits stay so they can be fixed. */
    saveRecordChangesError(msg: HostMessage<{ opId?: string; message?: string }>) {
      const opId = claim(msg, state.savingOpId.value);
      if (!opId) return;
      batch(() => {
        state.savingOpId.value = null;
        state.review.value = null;
        state.error.value = msg.data?.message ?? L().errorUnknown;
      });
    },
  };

  return {
    dirtyCount,
    loadInput,
    loadFromElsewhere,
    follow,
    back,
    cancel,
    setEdit,
    discardEdits,
    startReview,
    confirmSave,
    reset,
    handlers,
  };
}
export type RecordDetailController = ReturnType<typeof createRecordDetailController>;

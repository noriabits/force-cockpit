// @vitest-environment jsdom
//
// Pins WHICH exits drain the edit form's cleanups.
//
// Draining on the wrong path is silent and expensive: the folder combobox's
// cleanup removes its `input -> folder.value` sync, so a form drained while it
// is still on screen keeps accepting keystrokes in the category field while the
// signal goes stale — and the next Save writes the OLD folder with no error.
// That is exactly what happened when Delete drained at post time instead of on
// the confirmed reply.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, cleanup, act } from '@testing-library/preact';

const posted: Array<{ type: string }> = [];

vi.mock('./chart-rendering', () => ({
  ALL_CHART_TYPES: ['bar', 'line', 'pie', 'doughnut', 'metric', 'table'],
}));
// The real combobox is imperative DOM; here it only needs to register a cleanup
// so we can observe whether it was run.
const comboCleanup = vi.fn();
vi.mock('../../../shared/view/folder-combobox.js', () => ({
  buildFolderCombobox: () => {
    const element = document.createElement('div');
    element.appendChild(document.createElement('input'));
    return { element, cleanup: comboCleanup, refresh() {}, open() {}, close() {} };
  },
}));
vi.mock('../../../shared/view/host', () => ({
  post: (m: { type: string }) => posted.push(m),
}));

const { createEditForm, drainOpenEditForms, resolveReply } = await import('./edit-form');

const labels = {
  formatOptions: { '': 'None' },
  conditionOptions: { above: 'Above' },
  chartTypes: {
    bar: 'Bar',
    line: 'Line',
    pie: 'Pie',
    doughnut: 'Doughnut',
    metric: 'Metric',
    table: 'Table',
  },
  btnDelete: 'Delete',
  btnCancel: 'Cancel',
  btnSave: 'Save',
  btnSaving: 'Saving...',
  btnPreview: 'Preview',
  errorNameRequired: 'Name is required.',
  errorSoqlRequired: 'SOQL query is required.',
  errorLabelFieldRequired: 'Label field is required.',
};

const cfg = {
  id: 'ops/chart',
  folder: 'ops',
  name: 'Chart',
  description: '',
  soql: 'SELECT Id FROM Account',
  labelField: 'Name',
  valueFields: [{ field: 'Cnt', label: 'Count' }],
  chartType: 'bar' as const,
  refreshInterval: 0,
  source: 'user' as const,
};

type HookedCard = HTMLElement & {
  __pendingRunCleanups?: () => void;
  __pendingReplies?: Map<string, { fail: (m: string) => void; settle: () => void }>;
};

/** The requestId the form put on its most recent post. */
const lastRequestId = () =>
  (posted[posted.length - 1] as unknown as { requestId?: string }).requestId!;

function mountForm(
  into?: HTMLElement,
  configId: string | null = 'ops/chart',
  // Spied only by the applySaved cases below; every other test takes the inert
  // defaults it always had, so none of them changed when these were added.
  hooks: { buildViewCard?: (c: unknown) => HTMLElement; triggerQuery?: (c: unknown) => void } = {},
) {
  (window as unknown as { __setTooltip: () => void }).__setTooltip = () => {};
  const card = document.createElement('div');
  card.className = 'card';
  (into ?? document.body).appendChild(card);
  const form = createEditForm({
    labels,
    chartInstances: new Map(),
    getConfigs: () => [cfg],
    nextAvailablePosition: () => 0,
    buildViewCard: hooks.buildViewCard ?? (() => document.createElement('div')),
    triggerQuery: hooks.triggerQuery ?? (() => {}),
  } as never).buildEditForm({ ...cfg, id: configId } as never, card as never, configId);
  card.appendChild(form);
  return { card: card as HookedCard, form };
}

const clickBtn = (form: HTMLElement, text: string) =>
  fireEvent.click([...form.querySelectorAll('button')].find((b) => b.textContent === text)!);

const errorText = (form: HTMLElement) => form.querySelector('.error-box')!.textContent;

describe('edit form teardown', () => {
  // Not a trailing `cleanup()` per test: a failing assertion throws before it,
  // leaking the mounted DOM into the next test.
  afterEach(cleanup);
  beforeEach(() => {
    // `cleanup` only unmounts what testing-library itself rendered, and these
    // forms are mounted by hand — so without this every test's cards pile up in
    // the body, and a class-scoped lookup can match a previous test's form.
    //
    // It used to matter more sharply: the form's fields carried fixed ids, and
    // jsdom's `#id` fast path resolves against the whole document before
    // checking containment, so a leftover form made even a SCOPED
    // `form.querySelector('#monitoring-edit-soql')` return null. Those ids are
    // gone now — nothing read them and `<label>` never carried a `for`, so
    // eight duplicated ids were pure liability — but the reset stays: the
    // pile-up is real either way.
    document.body.innerHTML = '';
    posted.length = 0;
    comboCleanup.mockClear();
  });

  it('arms the drain on mount, before any submit', () => {
    // Arming on Save/Delete instead left a merely-open form (the user edited a
    // different card and saved that one) with no hook at all, so the reload
    // wiped it without ever running its folder combobox's cleanup.
    const { card } = mountForm();
    expect(typeof card.__pendingRunCleanups).toBe('function');
    expect(comboCleanup).not.toHaveBeenCalled();
  });

  it('Delete posts the request but does NOT drain — the modal may be dismissed', () => {
    const { card, form } = mountForm();
    clickBtn(form, 'Delete');

    expect(posted.map((m) => m.type)).toEqual(['deleteMonitoringConfig']);
    // The regression: draining here leaves a live form with no folder sync.
    expect(comboCleanup).not.toHaveBeenCalled();
    // ...and the drain stays armed, so the confirmed reply can still run it.
    expect(typeof card.__pendingRunCleanups).toBe('function');
  });

  it('the handed-over drain runs the cleanups, and only once', () => {
    const { card, form } = mountForm();
    clickBtn(form, 'Delete');

    card.__pendingRunCleanups!();
    expect(comboCleanup).toHaveBeenCalledTimes(1);
    card.__pendingRunCleanups!(); // config-loader + index.js can both reach it
    expect(comboCleanup).toHaveBeenCalledTimes(1);
  });

  it('drains EVERY open form, not just the one that replied', () => {
    // Several forms can be open at once: switchToEditMode closes no others and
    // addNewCard inserts one at grid.firstChild. A reply carries no card
    // identity, and the reload that follows does `grid.innerHTML = ''`, so
    // picking one card drained an arbitrary form and leaked the rest.
    const grid = document.createElement('div');
    document.body.appendChild(grid);
    // Neither has been submitted — arming happens on mount, so both are drainable.
    const a = mountForm(grid);
    mountForm(grid);

    drainOpenEditForms(grid);
    expect(comboCleanup).toHaveBeenCalledTimes(2);
    expect(typeof a.card.__pendingRunCleanups).toBe('function'); // still armed, already drained
    drainOpenEditForms(grid); // idempotent
    expect(comboCleanup).toHaveBeenCalledTimes(2);
  });

  it('Cancel drains immediately — that form is definitely gone', () => {
    const { form } = mountForm();
    clickBtn(form, 'Cancel');
    expect(comboCleanup).toHaveBeenCalledTimes(1);
  });

  it('the drain also kills the pending preview debounce', () => {
    // The timer used to be cleared only in the mount effect's teardown, which
    // fires on no path that exists today — so a Cancel (or a Save/Delete
    // reload) inside the 800ms window still posted a runMonitoringQuery for a
    // form that was already gone. The org ran it for nothing, and because
    // query-runner routes preview results by
    // `grid.querySelector('.monitoring-preview-canvas')` the late result landed
    // in whichever OTHER form happened to be open.
    vi.useFakeTimers();
    try {
      const { form } = mountForm();
      const soql = form.querySelector('.monitoring-soql-input')!;
      fireEvent.input(soql, { target: { value: 'SELECT Id FROM Contact' } });

      clickBtn(form, 'Cancel');
      vi.advanceTimersByTime(5000);

      expect(posted).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a debounce that is NOT drained still fires — the guard above is real', () => {
    // Without this the test above passes just as well if the debounce never
    // scheduled anything in the first place.
    vi.useFakeTimers();
    try {
      const { form } = mountForm();
      const soql = form.querySelector('.monitoring-soql-input')!;
      fireEvent.input(soql, { target: { value: 'SELECT Id FROM Contact' } });
      vi.advanceTimersByTime(5000);

      expect(posted.map((m) => m.type)).toEqual(['runMonitoringQuery']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('edit form correlated replies', () => {
  // Replies carry no card identity, so each submit mints a `requestId` and the
  // reply echoes it back (`MessageRouter._dispatchFeatureRoute` merges the whole
  // request onto the reply, so this costs the host nothing).
  //
  // The mechanism this replaced matched on "the first card still waiting",
  // justified by "at most one form is ever waiting" — which is false. Several
  // forms can be open, each Save is driven by its own `saving` signal, and
  // `setAllButtonsDisabled` skips edit forms, so two saves can be in flight
  // together. These tests pin the concurrent case, which is the one that broke.
  afterEach(cleanup);
  beforeEach(() => {
    document.body.innerHTML = '';
    posted.length = 0;
    comboCleanup.mockClear();
  });

  it('delivers a failure to the form that submitted it, with two saves in flight', () => {
    // Deliver the SECOND form's reply first. That ordering is what the old
    // mechanism could not express: it settled "the first card still waiting",
    // i.e. A, leaving B armed and A — still genuinely in flight — disarmed. A's
    // real failure then matched nothing and vanished. Delivering A's reply
    // first would have passed under both mechanisms and proved nothing.
    const grid = document.createElement('div');
    document.body.appendChild(grid);
    const a = mountForm(grid, 'ops/a');
    const b = mountForm(grid, 'ops/b');

    clickBtn(a.form, 'Save');
    const idA = lastRequestId();
    clickBtn(b.form, 'Save');
    const idB = lastRequestId();
    expect(idA).not.toBe(idB);

    act(() => resolveReply(grid, idB)!.settle()); // B succeeds first

    const savingBtn = (form: HTMLElement) =>
      [...form.querySelectorAll('button')].find((btn) => btn.textContent === 'Saving...');
    expect(savingBtn(b.form)).toBeUndefined(); // B released
    expect(savingBtn(a.form)!.disabled).toBe(true); // A untouched, still in flight

    act(() => resolveReply(grid, idA)!.fail('A failed'));
    expect(errorText(a.form)).toBe('A failed');
    expect(errorText(b.form)).toBe('');
  });

  it('an entry is one-shot — a finished request stops matching', () => {
    const grid = document.createElement('div');
    document.body.appendChild(grid);
    const { form } = mountForm(grid);

    clickBtn(form, 'Save');
    const id = lastRequestId();
    act(() => resolveReply(grid, id)!.fail('nope'));

    expect(resolveReply(grid, id)).toBeUndefined();
  });

  it('a failure releases the Save button', () => {
    const grid = document.createElement('div');
    document.body.appendChild(grid);
    const { form } = mountForm(grid);
    const btn = (text: string) =>
      [...form.querySelectorAll('button')].find((b) => b.textContent === text);

    clickBtn(form, 'Save');
    expect(btn('Saving...')!.disabled).toBe(true);
    act(() => resolveReply(grid, lastRequestId())!.fail('nope'));
    expect(btn('Save')!.disabled).toBe(false);
  });

  it('Delete mints its own id, so a delete error needs no prior Save', () => {
    // An earlier version borrowed the SAVE hook, which only Save ever armed, so
    // a delete error on a never-saved form fell through to the grid-level box.
    const grid = document.createElement('div');
    document.body.appendChild(grid);
    const { form } = mountForm(grid);

    clickBtn(form, 'Delete');
    const reply = resolveReply(grid, lastRequestId());
    expect(reply).toBeDefined();
    reply!.fail('delete failed');
    expect(errorText(form)).toBe('delete failed');
  });

  it('settling does NOT drain — the form stays fully usable', () => {
    // A dismissed delete modal and a completed save both leave the form on
    // screen. Draining would remove the folder combobox's `input -> signal`
    // sync, and the next Save would silently write the OLD category.
    const grid = document.createElement('div');
    document.body.appendChild(grid);
    const { form } = mountForm(grid);

    clickBtn(form, 'Delete');
    act(() => resolveReply(grid, lastRequestId())!.settle());

    expect(comboCleanup).not.toHaveBeenCalled();
  });

  it('teardown drops every pending entry, so a dead form claims nothing', () => {
    const grid = document.createElement('div');
    document.body.appendChild(grid);
    const { card, form } = mountForm(grid);

    clickBtn(form, 'Save');
    const id = lastRequestId();
    card.__pendingRunCleanups!();

    expect(resolveReply(grid, id)).toBeUndefined();
  });

  it('an unknown id resolves to nothing, so callers can fall back', () => {
    const grid = document.createElement('div');
    document.body.appendChild(grid);
    mountForm(grid);
    expect(resolveReply(grid, 'mreq-does-not-exist')).toBeUndefined();
    expect(resolveReply(grid, undefined)).toBeUndefined();
  });

  // ── applySaved: a save updates ONE card, not the whole grid ────────────────
  //
  // `onSaveResult` used to settle the reply and then call `loadConfigs()`, and
  // `onConfigsLoaded` rebuilt the grid from disk — tearing out every OTHER open
  // edit form, unsaved edits included, with no warning. These pin the
  // replacement: the form puts the PERSISTED record on screen in its own place
  // and leaves every other form alone.

  /** The persisted record as the host returns it — note the RE-SLUGGED id. */
  const saved = { ...cfg, id: 'ops/renamed', name: 'Renamed' };

  it('applySaved replaces the card using the persisted record, not the local draft', () => {
    const grid = document.createElement('div');
    document.body.appendChild(grid);
    const built: unknown[] = [];
    const { card, form } = mountForm(grid, 'ops/chart', {
      buildViewCard: (c) => {
        built.push(c);
        const view = document.createElement('div');
        view.className = 'card view-card';
        return view;
      },
    });

    clickBtn(form, 'Save');
    act(() => resolveReply(grid, lastRequestId())!.applySaved(saved as never));

    // Built from the host's record — the id is the one the host re-slugged, so
    // nothing webview-side had to track it. That hand-maintained id is the bug
    // the full reload was introduced to paper over.
    expect(built).toEqual([saved]);
    expect(grid.querySelector('.view-card')).not.toBeNull();
    expect(card.isConnected).toBe(false); // the form's card is gone from the grid
  });

  it('applySaved re-runs the query, or the new card renders blank', () => {
    // buildViewCard only builds a shell: the chart instance was destroyed on
    // entering edit mode, so without this the card sits empty until Refresh.
    const grid = document.createElement('div');
    document.body.appendChild(grid);
    const triggerQuery = vi.fn();
    const { form } = mountForm(grid, 'ops/chart', { triggerQuery });

    clickBtn(form, 'Save');
    act(() => resolveReply(grid, lastRequestId())!.applySaved(saved as never));

    expect(triggerQuery).toHaveBeenCalledWith(saved);
  });

  it('applySaved drains — unlike settle, this form really is gone', () => {
    const grid = document.createElement('div');
    document.body.appendChild(grid);
    const { form } = mountForm(grid);

    clickBtn(form, 'Save');
    act(() => resolveReply(grid, lastRequestId())!.applySaved(saved as never));

    // The card was replaced, so the folder combobox's document-level listener
    // would leak without this. Contrast the settle case above, where the form
    // stays on screen and draining would break its category field.
    expect(comboCleanup).toHaveBeenCalled();
  });

  it('saving one form leaves another open form untouched', () => {
    // THE bug this replaced: the reload rebuilt the grid, so saving A destroyed
    // B's in-progress edits too. Deliver B's save while A is merely open.
    const grid = document.createElement('div');
    document.body.appendChild(grid);
    const a = mountForm(grid, 'ops/a');
    const b = mountForm(grid, 'ops/b');

    clickBtn(b.form, 'Save');
    act(() => resolveReply(grid, lastRequestId())!.applySaved(saved as never));

    expect(b.card.isConnected).toBe(false); // B replaced by its view card
    expect(a.card.isConnected).toBe(true); // A still on screen
    expect(a.form.querySelector('.error-box')).not.toBeNull(); // still a live form
    expect(comboCleanup).toHaveBeenCalledTimes(1); // only B's combobox was torn down
  });

  it('the reply carries the id the form was OPENED with, which keys the upsert', () => {
    // index.js folds the record into `configs` keyed on this, not on saved.id:
    // the host re-slugs from folder + name, so a rename arrives under a
    // different id and matching on the new one would orphan the old entry.
    const grid = document.createElement('div');
    document.body.appendChild(grid);
    const { form } = mountForm(grid, 'ops/chart');
    clickBtn(form, 'Save');
    expect(resolveReply(grid, lastRequestId())!.configId).toBe('ops/chart');
  });

  it('a brand-new card reports a null configId, so the upsert appends', () => {
    const grid = document.createElement('div');
    document.body.appendChild(grid);
    const { form } = mountForm(grid, null);
    clickBtn(form, 'Save');
    expect(resolveReply(grid, lastRequestId())!.configId).toBeNull();
  });
});

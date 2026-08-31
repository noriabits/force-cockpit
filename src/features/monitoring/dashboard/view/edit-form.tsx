// The monitoring card edit form.
//
// Replaces the ~580-line imperative version of this file (`edit-form.js`).
// The public API is
// unchanged — `createEditForm(ctx)` still returns `{ buildEditForm }` and
// `buildEditForm` still returns a detached `HTMLElement` — so `card-builder.js`,
// `index.js` and `query-runner.js` are untouched, including the
// `card.__pending*` contract (both error hooks and the cleanup drain).
//
// What went away: `readScalarFormFields`, `readValueFields` and `readFormConfig`
// (~100 lines that read every value back OUT of the DOM at save time). The
// signals below ARE the state; `readFormConfig` is now a pure function of them.
//
// ─────────────────────────────────────────────────────────────────────────────
// LOAD-BEARING: five nodes in this form are mutated from OUTSIDE Preact.
// `query-runner.js` locates them by class from the grid root and writes
// `.style.display`, `.textContent` and `innerHTML` on them:
//
//   .monitoring-preview-canvas / -table / -metric  (plus the Chart.js instance
//                                                   bound to the canvas)
//   .monitoring-status
//   .error-box
//
// They are therefore rendered as **uncontrolled leaves**: the JSX declares no
// children and no `style` prop for them, so Preact's diff never touches those
// properties and an external write survives every re-render. The preview
// subtree goes further and is built imperatively into a ref'd container,
// because Chart.js owns that canvas outright.
//
// Do NOT add children or a `style` prop to any of those five. Doing so hands
// them to the vdom, and the next unrelated re-render will silently wipe
// whatever query-runner just wrote into them.
//
// The converse also holds and is easier to get wrong: the actions row IS
// vdom-owned (Save's `disabled` is bound to the `saving` signal), so nothing
// outside may write to it. `index.js`'s `setAllButtonsDisabled` used to, and now
// skips anything inside `.monitoring-edit-form` for exactly this reason.
// ─────────────────────────────────────────────────────────────────────────────

import { render } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { useSignal, useComputed } from '@preact/signals';
import { ALL_CHART_TYPES } from './chart-rendering';
import {
  FormRow,
  SelectField,
  ValueFieldRow,
  FolderCombobox,
  draftsToValueFields,
  emptyDraft,
  toDraft,
  PREVIEW_DEBOUNCE_MS,
  type DraftValueField,
  type EditableCard,
  type EditFormCtx,
  type PendingReply,
} from './edit-form-fields';
import { post } from '../../../shared/view/host';
import type {
  ChartType,
  DeleteMonitoringConfigMessage,
  MonitoringConfigPayload,
  RunMonitoringQueryMessage,
  SaveMonitoringConfigMessage,
} from '../../../../shared/protocol';

export type { EditFormCtx } from './edit-form-fields';

/** Per-session, not per-form: ids must be unique across every open form. */
let requestSeq = 0;

/** Same, for the preview id below — see `previewKeyRef`. */
let previewSeq = 0;

/**
 * Marks a `runMonitoringQuery` as an edit-form preview.
 *
 * The host tests only this prefix (see `RunMonitoringQueryMessage`), so
 * everything after it is the webview's own business — which is what lets the
 * suffix be per-FORM rather than per-config.
 */
const PREVIEW_PREFIX = '__preview__';

/**
 * The canvas element id a preview reply's `configId` names.
 *
 * Exported because `query-runner.js` resolves a reply back to the form that
 * asked for it through exactly this mapping, and the mapping belongs where the
 * canvas is created (in the mount effect below). It used to be re-derived there
 * by hand — `configId.replace('__preview__', '').replace(/\//g, '-')` — a second
 * copy of a rule only this file sets.
 */
export function previewCanvasIdFor(previewConfigId: string): string {
  return 'chart-preview-' + previewConfigId.slice(PREVIEW_PREFIX.length);
}

// ── The form ─────────────────────────────────────────────────────────────────

function EditForm(props: {
  cfg: MonitoringConfigPayload;
  card: EditableCard;
  configId: string | null;
  ctx: EditFormCtx;
}) {
  const { cfg, card, configId, ctx } = props;
  const L = ctx.labels;

  // Every field is a signal. This is the whole point of the migration: at save
  // time there is nothing to read back out of the DOM.
  const name = useSignal(cfg.name ?? '');
  const folder = useSignal(cfg.folder ?? '');
  const description = useSignal(cfg.description ?? '');
  const soql = useSignal(cfg.soql ?? '');
  const labelField = useSignal(cfg.labelField ?? '');
  const chartType = useSignal<string>(cfg.chartType ?? 'bar');
  const stacked = useSignal(cfg.stacked ?? false);
  const notifyOnIncrease = useSignal(cfg.notifyOnIncrease ?? false);
  const refreshInterval = useSignal(String(cfg.refreshInterval ?? 0));
  const isPrivate = useSignal(cfg.source === 'private');
  const valueFields = useSignal<DraftValueField[]>((cfg.valueFields ?? []).map(toDraft));
  const saving = useSignal(false);

  // Chart-type-driven visibility — was `updateFormVisibility` toggling
  // `.style.display` by hand on two rows.
  const isMetric = useComputed(() => chartType.value === 'metric');
  const showStacked = useComputed(() => chartType.value === 'bar' || chartType.value === 'line');

  // Nodes owned outside the vdom (see the header comment).
  const previewHost = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLSpanElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  const cleanups = useRef<Array<() => void>>([]);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Requests this form is still waiting on, keyed by the id it minted.
   *
   * The replies carry no card identity, so this is what makes a reply reach the
   * form that actually asked. It used to be a pair of bare callbacks resolved
   * by scanning for "the first card still waiting", on the claim that at most
   * one form is ever waiting — which is false: several forms can be open, each
   * Save is driven by its own `saving` signal, and `setAllButtonsDisabled`
   * deliberately skips edit forms, so two saves can be in flight at once. One
   * form's failure then landed on another, and once a success disarmed the
   * wrong form, on none at all.
   */
  const pending = useRef(new Map<string, PendingReply>());

  /**
   * Identifies THIS form's preview for its whole life, and nothing else's.
   *
   * A preview reply carries no card identity either — only the `configId` it was
   * sent with — so this is to the preview what `pending` is to a save: the thing
   * that makes the answer come back to the form that asked. `query-runner.js`
   * turns it into the canvas element id (`previewCanvasIdFor`) and takes the
   * owning form from there.
   *
   * Keyed per FORM, not per config, because two brand-new cards both have
   * `configId === null` (`+ Add Chart` twice) and would otherwise share one id —
   * and a shared id is a position match wearing a different hat. The `/` in a
   * saved config's id is stripped here, so the message id and the element id are
   * the same string and neither side has to remember a transformation.
   */
  const previewKeyRef = useRef<string | null>(null);
  if (previewKeyRef.current === null) {
    previewKeyRef.current = `${(configId || 'new').replace(/\//g, '-')}-${++previewSeq}`;
  }
  const previewId = PREVIEW_PREFIX + previewKeyRef.current;

  /**
   * Start waiting for a reply, and return the id to send with the request.
   *
   * Entries are one-shot — each removes itself as it fires — so a card never
   * answers for a request that has already finished. `settle` is the terminal
   * reply that is not a failure (a save that succeeded, a delete whose modal
   * was dismissed): stop waiting and release the button, but do NOT drain the
   * cleanups, because the form is still on screen.
   */
  function armReply(kind: 'save' | 'delete'): string {
    const id = `mreq-${++requestSeq}`;
    const done = () => {
      pending.current.delete(id);
      if (kind === 'save') saving.value = false;
    };
    pending.current.set(id, {
      fail: (msg: string) => {
        done();
        setError(msg);
      },
      settle: done,
    });
    return id;
  }

  /**
   * Drains the list, so the cleanups run at most once however the form goes
   * away. Armed on `card.__pendingRunCleanups` by the mount effect below, and
   * run only on the paths where the form is definitely gone:
   *
   *   - Cancel        — directly, here.
   *   - A grid rebuild — `config-loader.js` onConfigsLoaded, via
   *                      `drainOpenEditForms`, immediately before
   *                      `applyConfigs` wipes the grid. That is the reply to
   *                      the reload a confirmed Save or Delete asks for, and
   *                      the only moment the forms are certainly gone.
   *
   * NOT on the paths where the form survives: a save error, a delete error, a
   * delete whose native modal was dismissed (`{ deleted: false }`), or a reload
   * REQUEST (whose reply may be `loadMonitoringConfigsError`, leaving the grid
   * standing). Draining a live form is not merely wasteful — the folder
   * combobox's cleanup removes its `input -> folder.value` sync, after which the
   * category field still accepts keystrokes while the signal goes stale, and the
   * next Save writes the OLD folder with no visible error.
   *
   * That hook is this FUNCTION, not the array it used to be: `onSaveResult`
   * did its own `cleanups.forEach(...)` without draining, so the idempotency
   * only ever applied to the Cancel path. Handing over the drain is what makes
   * "at most once" actually true rather than merely documented.
   *
   * Every exit from this form must call this explicitly. The effect teardown
   * below also calls it, but that is belt-and-braces and does not fire on any
   * path that exists today: nothing calls `render(null, form)`, and
   * `switchToEditMode` does `card.innerHTML = ''`, tearing the DOM out behind
   * Preact's back — which unmounts nothing as far as Preact is concerned. It is
   * kept so that adding a real unmount later does the right thing by default.
   */
  function runCleanups(): void {
    // The pending preview debounce dies with the form. `triggerPreview` fires
    // 800ms after the last SOQL keystroke, so a Cancel/Save/Delete inside that
    // window would otherwise post a `runMonitoringQuery` for a form that is
    // already gone — a wasted org query whose late result `query-runner.js`
    // routes by `grid.querySelector('.monitoring-preview-canvas')`, i.e. into
    // whichever OTHER form happens to be open. This has to be here and not only
    // in the effect teardown below, which fires on no path that exists today.
    if (debounce.current) clearTimeout(debounce.current);
    // Anything this form was still waiting on dies with it. `resolveReply`
    // walks every card's map, so an entry left behind on a form that is gone
    // would keep claiming replies that can no longer be shown anywhere.
    pending.current.clear();
    // So does this form's Chart.js instance. `renderChart` only ever destroys
    // the instance under the key it is about to overwrite, and `previewId` is
    // unique per form — so once this form is gone nothing will ever reuse that
    // key, and the chart would hold a detached canvas in `chartInstances`
    // forever. (Before the id was per-form this leaked too, just more slowly:
    // the entry survived until the same card was edited again.)
    const chart = ctx.chartInstances.get(previewId);
    if (chart) {
      chart.destroy();
      ctx.chartInstances.delete(previewId);
    }
    const fns = cleanups.current.splice(0);
    fns.forEach((fn) => fn());
  }

  function setStatus(text: string): void {
    if (statusRef.current) statusRef.current.textContent = text;
  }
  function setError(text: string): void {
    const el = errorRef.current;
    if (!el) return;
    el.textContent = text;
    el.style.display = text ? '' : 'none';
  }

  // Build the Chart.js-owned preview subtree once, imperatively. Chart.js
  // mutates the canvas directly, so it must never be part of the diff.
  //
  // `useLayoutEffect`, not `useEffect`: `buildEditForm` returns this element and
  // its caller may hand it straight to code that queries for
  // `.monitoring-preview-canvas`. A plain effect is deferred past paint, so the
  // "fully populated when returned" claim below would only hold for the vdom,
  // not for the three nodes it appends. No consumer reads them that early
  // today — but
  // the invariant should be true, not true by luck.
  useLayoutEffect(() => {
    const hostEl = previewHost.current;
    if (!hostEl) return;

    const canvas = document.createElement('canvas');
    // The one id this form deliberately renders — it is how a preview reply
    // finds its way back here (see `previewKeyRef`), not a handle for anyone
    // else to query by. Every other input in this form is id-less on purpose.
    canvas.id = previewCanvasIdFor(previewId);
    canvas.className = 'monitoring-preview-canvas';

    const table = document.createElement('div');
    table.className = 'monitoring-table-wrapper monitoring-preview-table';
    table.style.display = 'none';

    const metric = document.createElement('div');
    metric.className = 'monitoring-metric-display monitoring-preview-metric';
    metric.style.display = 'none';

    hostEl.append(canvas, table, metric);
    if (errorRef.current) errorRef.current.style.display = 'none';

    // Arm the drain on MOUNT, not on Save/Delete. Those only fire once the user
    // submits, so a form that is merely open — the user edited another card and
    // saved that one — carried no hook at all and leaked its folder combobox's
    // document-level listener when the reload wiped the grid. Every open form
    // is now drainable by `drainOpenEditForms`, whichever card the reply is for.
    card.__pendingRunCleanups = runCleanups;
    card.__pendingReplies = pending.current;

    // Belt-and-braces only — see runCleanups above for why Preact never
    // unmounts this component in practice. `runCleanups` drains, so this
    // double-running with an explicit call is harmless.
    return runCleanups;
  }, []);

  /** The replacement for `readFormConfig` — now pure over the signals. */
  function readFormConfig(): MonitoringConfigPayload {
    const rows = draftsToValueFields(valueFields.value);
    const position = configId ? cfg.position : ctx.nextAvailablePosition();
    return {
      id: configId || '',
      // Previous location — lets the host delete the old file when the
      // category or name changes (move semantics).
      source: cfg.source,
      folder: folder.value.trim() || 'general',
      name: name.value.trim(),
      description: description.value.trim(),
      soql: soql.value.trim(),
      labelField: labelField.value.trim(),
      valueFields: rows.length > 0 ? rows : cfg.valueFields,
      chartType: chartType.value as ChartType,
      refreshInterval: parseInt(refreshInterval.value, 10) || 0,
      stacked: stacked.value,
      notifyOnIncrease: notifyOnIncrease.value,
      ...(typeof position === 'number' ? { position } : {}),
    };
  }

  function triggerPreview(): void {
    const live = readFormConfig();
    if (!live.soql || live.valueFields.length === 0) return;
    if (live.chartType !== 'metric' && !live.labelField) return;

    setStatus(L.statusLoading);
    setError('');

    const preview: RunMonitoringQueryMessage = {
      type: live.chartType === 'table' ? 'runMonitoringTableQuery' : 'runMonitoringQuery',
      configId: previewId,
      configName: live.name,
      soql: live.soql,
      labelField: live.labelField,
      valueFields: live.valueFields,
    };
    post(preview);
  }

  function onSoqlInput(value: string): void {
    soql.value = value;
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(triggerPreview, PREVIEW_DEBOUNCE_MS);
  }

  function onChartTypeChange(next: string): void {
    // Instant retype of the existing preview chart (canvas types only).
    const chart = ctx.chartInstances.get(previewId);
    if (chart) {
      chart.config.type = next;
      chart.update();
    }
  }

  function onSave(): void {
    const live = readFormConfig();
    if (!live.name) return setError(L.errorNameRequired);
    if (!live.soql) return setError(L.errorSoqlRequired);
    if (!live.labelField && live.chartType !== 'metric') {
      return setError(L.errorLabelFieldRequired);
    }

    saving.value = true;
    const save: SaveMonitoringConfigMessage = {
      type: 'saveMonitoringConfig',
      requestId: armReply('save'),
      config: live,
      isPrivate: isPrivate.value,
    };
    post(save);
  }

  function onCancel(): void {
    runCleanups();
    if (!configId) {
      card.remove(); // New card — just drop it.
      return;
    }
    // Revert to view mode. buildViewCard only builds an empty shell (the chart
    // instance was destroyed on entering edit mode), so re-run the query or the
    // card stays blank until the user hits Refresh.
    const original = ctx.getConfigs().find((c) => c.id === configId) || cfg;
    card.replaceWith(ctx.buildViewCard(original));
    ctx.triggerQuery(original);
  }

  function onDelete(): void {
    if (!configId) return; // Delete is only rendered for a persisted config.
    // Do NOT drain here: the host shows a native modal and replies
    // `{ deleted: false }` if the user dismisses it, leaving this form on
    // screen. Draining a live form removes the folder combobox's
    // `input -> folder.value` sync, so the category field keeps accepting
    // keystrokes while the signal goes stale and the next Save silently writes
    // the OLD folder. The drain is already armed (mount effect above);
    // `config-loader.js`'s onDeleteResult runs it on the confirmed path only.
    //
    // Both outcomes are still terminal for THIS request, so both settle the
    // entry armed here: `onDeleteResult` on a dismissed modal, `onDeleteError`
    // on a failure. Settling is not draining.
    const del: DeleteMonitoringConfigMessage = {
      type: 'deleteMonitoringConfig',
      requestId: armReply('delete'),
      configId,
      configName: cfg.name,
      source: cfg.source ?? 'user',
      isPrivate: cfg.source === 'private',
    };
    post(del);
  }

  const patchRow = (key: number, patch: Partial<DraftValueField>) => {
    valueFields.value = valueFields.value.map((r) => (r.key === key ? { ...r, ...patch } : r));
  };

  return (
    <>
      <FormRow label={L.labelName}>
        <input
          type="text"
          class="text-input"
          placeholder={L.placeholderName}
          value={name.value}
          onInput={(e) => (name.value = (e.target as HTMLInputElement).value)}
        />
      </FormRow>

      <FormRow label={L.labelCategory}>
        <FolderCombobox
          value={folder}
          placeholder={L.placeholderCategory}
          getFolders={() => ctx.getConfigs().map((c) => c.folder)}
          registerCleanup={(fn) => cleanups.current.push(fn)}
        />
      </FormRow>

      <FormRow label={L.labelDescription}>
        <input
          type="text"
          class="text-input"
          placeholder={L.placeholderDescription}
          value={description.value}
          onInput={(e) => (description.value = (e.target as HTMLInputElement).value)}
        />
      </FormRow>

      <FormRow label={L.labelSoql}>
        <textarea
          class="text-input monitoring-soql-input"
          placeholder={L.placeholderSoql}
          value={soql.value}
          onInput={(e) => onSoqlInput((e.target as HTMLTextAreaElement).value)}
        />
      </FormRow>

      {/* Hidden for metric — a metric card has no X axis to label. */}
      {!isMetric.value && (
        <FormRow label={L.labelLabelField}>
          <input
            type="text"
            class="text-input"
            placeholder={L.placeholderLabelField}
            value={labelField.value}
            onInput={(e) => (labelField.value = (e.target as HTMLInputElement).value)}
          />
        </FormRow>
      )}

      <FormRow label={L.labelValueFields}>
        <div class="monitoring-value-fields">
          {valueFields.value.map((row) => (
            <ValueFieldRow
              key={row.key}
              row={row}
              labels={L}
              canRemove={valueFields.value.length > 1}
              onPatch={(patch) => patchRow(row.key, patch)}
              onRemove={() => {
                valueFields.value = valueFields.value.filter((r) => r.key !== row.key);
              }}
            />
          ))}
          <button
            class="btn btn-secondary btn-sm"
            style={{ alignSelf: 'flex-start' }}
            onClick={() => (valueFields.value = [...valueFields.value, emptyDraft()])}
          >
            {L.btnAddValueField}
          </button>
        </div>
      </FormRow>

      <FormRow label={L.labelChartType}>
        <SelectField
          value={chartType}
          onChange={onChartTypeChange}
          class="text-input monitoring-chart-type-select"
          style={{ width: 'auto' }}
          options={Object.fromEntries(
            (ALL_CHART_TYPES as string[]).map((t) => [t, L.chartTypes[t]]),
          )}
        />
      </FormRow>

      {/* Stacking only means anything for bar and line. */}
      {showStacked.value && (
        <FormRow label={L.labelStacked} inline>
          <input
            type="checkbox"
            checked={stacked.value}
            onChange={(e) => (stacked.value = (e.target as HTMLInputElement).checked)}
          />
        </FormRow>
      )}

      <FormRow label={L.labelNotifyOnIncrease} inline>
        <input
          type="checkbox"
          checked={notifyOnIncrease.value}
          onChange={(e) => (notifyOnIncrease.value = (e.target as HTMLInputElement).checked)}
        />
      </FormRow>

      <FormRow label={L.labelRefreshInterval}>
        <input
          type="number"
          min="0"
          class="text-input"
          style={{ width: '80px' }}
          value={refreshInterval.value}
          onInput={(e) => (refreshInterval.value = (e.target as HTMLInputElement).value)}
        />
      </FormRow>

      <FormRow label={L.labelPrivate} inline>
        <input
          type="checkbox"
          checked={isPrivate.value}
          onChange={(e) => (isPrivate.value = (e.target as HTMLInputElement).checked)}
        />
      </FormRow>

      {/* Uncontrolled from here down — see the header comment. No children,
          no style prop: query-runner.js owns what goes inside these. */}
      <div ref={previewHost} class="monitoring-preview-wrapper monitoring-canvas-wrapper" />
      <span ref={statusRef} class="monitoring-status" />
      <div ref={errorRef} class="error-box" />

      <div class="monitoring-edit-actions">
        <button class="btn btn-secondary" onClick={triggerPreview}>
          {L.btnPreview}
        </button>
        <button class="btn btn-primary" disabled={saving.value} onClick={onSave}>
          {saving.value ? L.btnSaving : L.btnSave}
        </button>
        <button class="btn btn-secondary" onClick={onCancel}>
          {L.btnCancel}
        </button>
        {configId && (
          <button class="btn monitoring-form-delete-btn" onClick={onDelete}>
            {L.btnDelete}
          </button>
        )}
      </div>
    </>
  );
}

// ── Public API (unchanged) ───────────────────────────────────────────────────

/**
 * Drain every open edit form in the grid.
 *
 * Exactly one caller: `config-loader.js`'s `onConfigsLoaded`, which runs it
 * immediately before `applyConfigs` rebuilds the grid. NOT at the point a
 * reload is *requested* (`onSaveResult`, a confirmed `onDeleteResult`) — that
 * request can come back as `loadMonitoringConfigsError`, leaving the grid and
 * every form intact but drained, and a drained form that stays on screen keeps
 * accepting keystrokes in the category field while the folder combobox's
 * `input -> folder.value` sync is gone, so the next Save writes the OLD folder
 * with no error.
 *
 * ALL of them, not "the one that replied": several forms can be open at once
 * (`switchToEditMode` closes no others, and `addNewCard` inserts one at
 * `grid.firstChild`), and a reply carries no card identity — so picking the
 * first match drained an arbitrary form and leaked the rest of their
 * document-level click-outside listeners when `renderAll` did `innerHTML = ''`.
 * Since the rebuild destroys every form regardless, draining every form is both
 * correct and the only thing that needs no identity. `runCleanups` drains its
 * own list, so a repeat call is a no-op.
 */
export function drainOpenEditForms(grid: HTMLElement): void {
  for (const card of grid.querySelectorAll<HTMLElement>('.card')) {
    (card as EditableCard).__pendingRunCleanups?.();
  }
}

/**
 * Find what to do with the reply to `requestId`, wherever it came from.
 *
 * Still a scan over the grid — a reply carries no card identity — but an EXACT
 * one: it can only match the form that minted that id. The previous version
 * took "the first card still waiting", which is the same thing only while at
 * most one form is waiting, and that was never guaranteed: several forms can be
 * open, each Save is driven by its own signal, and `setAllButtonsDisabled`
 * skips edit forms, so two saves can be in flight together. One form's failure
 * then surfaced in another's error box, and once a success disarmed the wrong
 * form, a real failure reached none at all.
 *
 * Returns `undefined` when nothing is waiting on it — a reply for a form that
 * has since been cancelled or rebuilt away — which callers treat as "drop it".
 */
export function resolveReply(grid: HTMLElement, requestId: unknown): PendingReply | undefined {
  if (typeof requestId !== 'string' || !requestId) return undefined;
  for (const card of grid.querySelectorAll<HTMLElement>('.card')) {
    const hit = (card as EditableCard).__pendingReplies?.get(requestId);
    if (hit) return hit;
  }
  return undefined;
}

export function createEditForm(ctx: EditFormCtx) {
  /**
   * Build the edit form for a card. Returns a detached element, exactly as the
   * imperative version did, so every call site is unaffected.
   */
  function buildEditForm(
    cfg: MonitoringConfigPayload,
    card: EditableCard,
    configId: string | null,
  ): HTMLElement {
    const form = document.createElement('div');
    form.className = 'monitoring-edit-form';
    // Preact's initial render into an empty container is synchronous, so the
    // element is fully populated by the time it is returned.
    render(<EditForm cfg={cfg} card={card} configId={configId} ctx={ctx} />, form);
    return form;
  }

  return { buildEditForm };
}

// Leaf components and pure draft<->config mapping for the monitoring edit form.
//
// The form that composes these — and every rule about it worth knowing (which
// nodes are mutated from outside Preact and must stay uncontrolled, when the
// cleanups drain, what the `card.__pending*` contract is) — lives in
// `edit-form.tsx`. Read that header before changing either file; it is not
// repeated here, because two copies of a load-bearing warning drift and the
// copy attached to the wrong file is the one that gets believed.
//
// Nothing in THIS file renders any of those externally-written nodes. What is
// here is ordinary: three leaf components (`FormRow`, `SelectField`,
// `ValueFieldRow`), one that wraps the imperative shared folder combobox
// (`FolderCombobox`), and the pure draft<->config mapping the form's save path
// is built on (`toDraft` / `emptyDraft` / `draftsToValueFields`).
//
// The one rule that IS local: every mount effect below is `useLayoutEffect`,
// never `useEffect`. `buildEditForm` hands the rendered element straight back to
// its caller, so anything a mount effect writes to the DOM must be there before
// paint. `FolderCombobox` has the sharpest version — a deferred effect would
// leave its cleanup UNREGISTERED until after paint, so a form torn down in that
// window leaks the document-level listener.

import { useLayoutEffect, useRef } from 'preact/hooks';
import { type Signal } from '@preact/signals';
import { buildFolderCombobox } from '../../../shared/view/folder-combobox.js';
import type {
  MonitoringConfigPayload,
  ThresholdCondition,
  ValueFieldPayload,
  ValueFormat,
} from '../../../../shared/protocol';

// ── Types ────────────────────────────────────────────────────────────────────

/** A value-field row while it is being edited: strings, because inputs hold strings. */
export interface DraftValueField {
  /** Stable identity for the list key — index would break on remove. */
  key: number;
  field: string;
  label: string;
  format: string;
  threshold: string;
  thresholdCondition: string;
}

export interface EditFormCtx {
  labels: Labels;
  /**
   * The shared Chart.js registry (`index.js` owns it). Structurally typed to
   * the three members the form actually uses rather than pulled in from
   * `chart.js`: this module is compiled by the webview config, Chart.js reaches
   * the page as a vendor `<script>` (`window.Chart`) and is not a bundle import.
   * `destroy` is here because the form is what removes its own preview entry —
   * see `runCleanups` in edit-form.tsx.
   */
  chartInstances: Map<
    string,
    { config: { type: string }; update: () => void; destroy: () => void }
  >;
  getConfigs: () => MonitoringConfigPayload[];
  nextAvailablePosition: () => number;
  buildViewCard: (cfg: MonitoringConfigPayload) => HTMLElement;
  triggerQuery: (cfg: MonitoringConfigPayload) => void;
}

/** The labels object is a plain string bag loaded from labels.js. */
type Labels = Record<string, string> & {
  formatOptions: Record<string, string>;
  conditionOptions: Record<string, string>;
  chartTypes: Record<string, string>;
};

/** What a form does when the reply to one of its submits comes back. */
export interface PendingReply {
  /** The request failed: show the message here, and stop waiting. */
  fail: (msg: string) => void;
  /** A terminal reply that is not a failure: stop waiting, release the button. */
  settle: () => void;
  /** The id this form was opened on — `null` for a brand-new card. */
  configId: string | null;
  /**
   * A save succeeded: tear this form down and put the PERSISTED record on
   * screen in its place, instead of reloading the whole grid. See `applySaved`
   * in edit-form.tsx for why the id never has to be tracked webview-side.
   */
  applySaved: (saved: MonitoringConfigPayload) => void;
}

/**
 * The card element carries the reply contract index.js and config-loader.js
 * invoke.
 *
 * Keyed by the `requestId` the form minted on submit. It is a map, not a pair
 * of callbacks, because the reply carries no card identity of its own: several
 * forms can be open and saving at the same time, so "the first card still
 * waiting" is not the form that asked. See `resolveReply`.
 *
 * Entries are one-shot — an entry removes itself as it fires — so a card never
 * answers for a request that is already finished.
 */
export type EditableCard = HTMLElement & {
  /** requestId -> what to do with that request's reply. */
  __pendingReplies?: Map<string, PendingReply>;
  /** The form's cleanup DRAIN (not the raw list) — see `runCleanups`. */
  __pendingRunCleanups?: () => void;
};

function setTooltip(el: HTMLElement | null, text: string): void {
  if (el)
    (window as unknown as { __setTooltip(e: HTMLElement, t: string): void }).__setTooltip(el, text);
}

export const PREVIEW_DEBOUNCE_MS = 800;

// ── Leaf components ──────────────────────────────────────────────────────────

export function FormRow(props: {
  label: string;
  inline?: boolean;
  children: preact.ComponentChildren;
}) {
  return (
    <div class={'monitoring-form-row' + (props.inline ? ' monitoring-form-row--inline' : '')}>
      <label class="monitoring-form-label">{props.label}</label>
      {props.children}
    </div>
  );
}

/**
 * A <select> bound to a signal, with its options from a label bag.
 *
 * Deliberately has no `tooltip` prop: the only usage (chart type) is already
 * labelled by its `FormRow`. The unlabelled selects that DO need one are the
 * value-field format/condition pair in `ValueFieldRow`, which own their refs.
 */
export function SelectField(props: {
  value: Signal<string>;
  options: Record<string, string>;
  class: string;
  onChange?: (v: string) => void;
  style?: Record<string, string>;
}) {
  return (
    <select
      class={props.class}
      style={props.style}
      value={props.value.value}
      onChange={(e) => {
        const v = (e.target as HTMLSelectElement).value;
        props.value.value = v;
        props.onChange?.(v);
      }}
    >
      {Object.entries(props.options).map(([val, lbl]) => (
        <option key={val} value={val}>
          {lbl}
        </option>
      ))}
    </select>
  );
}

export function ValueFieldRow(props: {
  row: DraftValueField;
  labels: Labels;
  canRemove: boolean;
  onPatch: (patch: Partial<DraftValueField>) => void;
  onRemove: () => void;
}) {
  const { row, labels: L } = props;
  const fieldRef = useRef<HTMLInputElement>(null);
  const labelRef = useRef<HTMLInputElement>(null);
  const thresholdRef = useRef<HTMLInputElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  const formatRef = useRef<HTMLSelectElement>(null);
  const conditionRef = useRef<HTMLSelectElement>(null);

  // Every control in this row is an unlabelled cell in a dense grid — the
  // tooltip IS the label. The two selects were missed in the Preact port, which
  // left `labelValueFieldFormat` and `labelThresholdCondition` unreferenced.
  //
  // `useLayoutEffect` throughout this file, never `useEffect`: `buildEditForm`
  // hands the rendered element straight back to its caller, so anything a mount
  // effect writes to the DOM must be there before paint for the "fully
  // populated when returned" claim to hold for the DOM and not just the vdom.
  useLayoutEffect(() => {
    setTooltip(fieldRef.current, L.labelValueFieldApi);
    setTooltip(labelRef.current, L.labelValueFieldLabel);
    setTooltip(formatRef.current, L.labelValueFieldFormat);
    setTooltip(thresholdRef.current, L.placeholderThreshold);
    setTooltip(conditionRef.current, L.labelThresholdCondition);
    setTooltip(removeRef.current, L.btnRemoveValueFieldTooltip);
  }, []);

  return (
    <div class="monitoring-value-field-row">
      <input
        ref={fieldRef}
        type="text"
        class="text-input"
        placeholder={L.placeholderValueFieldApi}
        value={row.field}
        onInput={(e) => props.onPatch({ field: (e.target as HTMLInputElement).value })}
      />
      <input
        ref={labelRef}
        type="text"
        class="text-input"
        placeholder={L.placeholderValueFieldLabel}
        value={row.label}
        onInput={(e) => props.onPatch({ label: (e.target as HTMLInputElement).value })}
      />
      <select
        ref={formatRef}
        class="monitoring-vf-format-select"
        value={row.format}
        onChange={(e) => props.onPatch({ format: (e.target as HTMLSelectElement).value })}
      >
        {Object.entries(L.formatOptions).map(([val, lbl]) => (
          <option key={val} value={val}>
            {lbl}
          </option>
        ))}
      </select>
      <input
        ref={thresholdRef}
        type="number"
        min="0"
        class="text-input monitoring-vf-threshold-input"
        placeholder={L.placeholderThreshold}
        value={row.threshold}
        onInput={(e) => props.onPatch({ threshold: (e.target as HTMLInputElement).value })}
      />
      <select
        ref={conditionRef}
        class="monitoring-vf-condition-select"
        value={row.thresholdCondition}
        onChange={(e) =>
          props.onPatch({ thresholdCondition: (e.target as HTMLSelectElement).value })
        }
      >
        {Object.entries(L.conditionOptions).map(([val, lbl]) => (
          <option key={val} value={val}>
            {lbl}
          </option>
        ))}
      </select>
      <button
        ref={removeRef}
        class="monitoring-remove-vf-btn"
        // Mirrors the original: never remove the last remaining row.
        onClick={() => props.canRemove && props.onRemove()}
      >
        {L.btnRemoveValueField}
      </button>
    </div>
  );
}

/**
 * Mounts the imperative folder combobox (a shared, DOM-owning module reused
 * verbatim) and registers its document-level click-outside listener for cleanup.
 *
 * Passes no `inputId`: nothing reads the monitoring combobox's DOM id, and an
 * unread id is only a liability here — several forms can be open at once
 * (`switchToEditMode` closes no others, `addNewCard` inserts one at
 * `grid.firstChild`, and `drainOpenEditForms` exists because of it), so a fixed
 * one duplicates across the document. It was briefly uniquified with a counter;
 * deleting the attribute is the better answer than generating a unique value
 * nobody consumes. `buildFolderCombobox` treats it as optional.
 *
 * `useLayoutEffect`, not `useEffect` — the same rule every mount effect in this
 * file follows, and for the same reason as the preview subtree in edit-form.tsx:
 * `buildEditForm` calls Preact's `render()` and hands the
 * element straight back, so a deferred effect would leave the combobox absent —
 * and, worse, its cleanup UNREGISTERED — until after paint. A form torn down in
 * that window would leak the document-level listener.
 */
export function FolderCombobox(props: {
  value: Signal<string>;
  placeholder: string;
  getFolders: () => string[];
  registerCleanup: (fn: () => void) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const combo = buildFolderCombobox({
      classPrefix: 'monitoring-folder',
      value: props.value.value,
      placeholder: props.placeholder,
      getFolders: props.getFolders,
      onSelect: (folder: string) => {
        props.value.value = folder;
      },
    });
    host.current?.appendChild(combo.element);
    // Free-text is allowed, so the input is the source of truth, not onSelect.
    const input = combo.element.querySelector('input');
    const sync = () => {
      props.value.value = (input as HTMLInputElement).value;
    };
    input?.addEventListener('input', sync);
    props.registerCleanup(() => {
      input?.removeEventListener('input', sync);
      combo.cleanup();
    });
  }, []);
  // Wrapper carries no styles of its own: it is `display: contents` so the
  // combobox keeps the grid position the original markup gave it.
  return <div ref={host} style={{ display: 'contents' }} />;
}

// ── Draft <-> config mapping (pure) ──────────────────────────────────────────

let nextKey = 1;

export function toDraft(vf: ValueFieldPayload): DraftValueField {
  return {
    key: nextKey++,
    field: vf.field,
    label: vf.label,
    format: vf.format ?? '',
    threshold: vf.threshold != null ? String(vf.threshold) : '',
    thresholdCondition: vf.thresholdCondition ?? 'above',
  };
}

export function emptyDraft(): DraftValueField {
  return {
    key: nextKey++,
    field: '',
    label: '',
    format: '',
    threshold: '',
    thresholdCondition: 'above',
  };
}

/**
 * The replacement for `readValueFields`. Same rules as the original: a row with
 * no API name is dropped, the label defaults to the field name, and a threshold
 * only carries its condition when the number actually parses.
 */
export function draftsToValueFields(rows: DraftValueField[]): ValueFieldPayload[] {
  const out: ValueFieldPayload[] = [];
  for (const r of rows) {
    const field = r.field.trim();
    if (!field) continue;
    const vf: ValueFieldPayload = { field, label: r.label.trim() || field };
    if (r.format) vf.format = r.format as ValueFormat;
    const threshold = r.threshold.trim() !== '' ? Number(r.threshold) : undefined;
    if (threshold != null && !isNaN(threshold)) {
      vf.threshold = threshold;
      vf.thresholdCondition = r.thresholdCondition as ThresholdCondition;
    }
    out.push(vf);
  }
  return out;
}

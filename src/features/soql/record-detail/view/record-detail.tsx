// The Record Detail's UI. Everything it does goes through the controller
// (record-detail-controller.tsx); this file only renders the signal bag, which
// mirrors whichever record tab is active.
//
// ONE UNCONTROLLED LEAF: `.query-tab-bar` — tab-strip.js owns its children
// outright, so it is rendered with no children and no `style` prop, and the
// strip is built in a useLayoutEffect (never useEffect) so it exists before
// index.tsx registers the host handlers and asks for the persisted tabs.
//
// The paste button must stay IMMEDIATELY after the Id input: paste-buttons.js
// resolves its target as `previousElementSibling`.
import { useLayoutEffect, useRef } from 'preact/hooks';
import type {
  FieldAccessNote,
  HiddenField,
  RecordDetailField,
  RecordDetailData,
} from '../../../../shared/protocol';
import { FLAG_COLUMNS, FlagCells, FlagHeaders } from '../../../shared/view/field-flags';
import { accessSummary, accessTooltip } from './access-note';
import type { RecordDetailController, RecordDetailState } from './record-detail-controller';
import { displayValue, isDirty, toRawValue } from './record-edits';
import { FieldValue } from './field-editor';
import { RecordCompare } from './record-compare-pane';
import { Tooltip } from './tooltip';

interface CockpitWindow {
  __vscode: { postMessage: (msg: unknown) => void };
  RecordDetailLabels: Record<string, string>;
}
const win = () => window as unknown as CockpitWindow;
const L = () => win().RecordDetailLabels;

interface Props {
  state: RecordDetailState;
  controller: RecordDetailController;
}

/**
 * One table row: a field the user can read (value + maybe an editor), or one
 * field-level security hides entirely (FieldDefinition only — no value, no flags).
 */
type Row = { kind: 'field'; field: RecordDetailField } | { kind: 'hidden'; field: HiddenField };

/** Both kinds, by API name — a hidden field sits where it would if it were visible. */
function rowsOf(rec: RecordDetailData): Row[] {
  const rows: Row[] = [
    ...rec.fields.map((field) => ({ kind: 'field' as const, field })),
    ...rec.hiddenFields.map((field) => ({ kind: 'hidden' as const, field })),
  ];
  return rows.sort((a, b) => a.field.name.localeCompare(b.field.name));
}

/** Case-insensitive match on label, API name, type or the shown value. */
function matchesFilter(row: Row, rec: RecordDetailData, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const { field } = row;
  const value = row.kind === 'field' ? displayValue(row.field, rec.values[field.name]) : '';
  return [field.label, field.name, field.type, value].some((s) => s.toLowerCase().includes(q));
}

/** 🔒 No edit access / 🔒 No read access — the reason and who would lift it ride the tooltip. */
function FlsBadge({ note }: { note: FieldAccessNote }) {
  return (
    <Tooltip text={accessTooltip(note, L())} wrap class="rec-detail-fls-badge">
      {note.kind === 'readOnly' ? L().flsReadOnlyBadge : L().flsHiddenBadge}
    </Tooltip>
  );
}

function Toolbar({ state, controller }: Props) {
  const loading = state.loadingOpId.value !== null;
  return (
    <div class="rec-detail-toolbar">
      <div class="input-with-paste rec-detail-id-wrap">
        <input
          type="text"
          class="text-input rec-detail-id-input"
          placeholder={L().idPlaceholder}
          value={state.idInput.value}
          onInput={(e) => controller.setIdDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') controller.showInput();
          }}
        />
        <button type="button" class="paste-btn" tabIndex={-1} title="Paste from clipboard">
          📋
        </button>
      </div>
      <button
        type="button"
        class={loading ? 'btn btn-primary running' : 'btn btn-primary'}
        disabled={loading}
        onClick={() => controller.showInput()}
      >
        {L().show}
      </button>
      <button
        type="button"
        class="btn btn-ghost rec-detail-clone"
        onClick={() => controller.cloneActiveTab()}
      >
        {L().cloneTab}
      </button>
      {loading && (
        <button type="button" class="btn btn-ghost" onClick={() => controller.cancel()}>
          {L().cancel}
        </button>
      )}
    </div>
  );
}

function RecordHeader({ state, controller }: Props) {
  const rec = state.record.value;
  // Nothing loaded in this tab (never asked, loading, or the load failed).
  if (!rec) return null;
  return (
    <div class="rec-detail-header">
      <span class="rec-detail-title">
        {rec.objectLabel} <span class="rec-detail-subtle">({rec.objectName})</span>
      </span>
      <span class="rec-detail-id">{rec.id}</span>
      {accessSummary(rec.access, L()) && (
        <span class="rec-detail-fls-summary">{accessSummary(rec.access, L())}</span>
      )}
      <Tooltip text={controller.canCompare.value ? '' : L().compareOnlyOne}>
        <button
          type="button"
          class="btn btn-ghost rec-detail-compare"
          aria-disabled={!controller.canCompare.value}
          onClick={() => controller.canCompare.value && controller.openCompare()}
        >
          {L().compare}
        </button>
      </Tooltip>
      <button
        type="button"
        class="btn btn-ghost rec-detail-open"
        onClick={() => win().__vscode.postMessage({ type: 'openRecord', recordId: rec.id })}
      >
        {L().openInSalesforce}
      </button>
    </div>
  );
}

function rowClass(dirty: boolean, note: FieldAccessNote | undefined): string {
  if (dirty) return 'rec-detail-tr rec-detail-tr--dirty';
  if (note?.kind === 'readOnly') return 'rec-detail-tr rec-detail-tr--fls-readonly';
  if (note?.kind === 'hidden') return 'rec-detail-tr rec-detail-tr--fls-hidden';
  return 'rec-detail-tr';
}

function FieldRow({ field, ...props }: Props & { field: RecordDetailField }) {
  const rec = props.state.record.value as RecordDetailData;
  const edits = props.state.edits.value;
  const original = rec.values[field.name];
  const raw = field.name in edits ? edits[field.name] : toRawValue(field, original);
  const dirty = field.name in edits && isDirty(field, original, raw);
  const note = rec.access[field.name];
  return (
    <tr class={rowClass(dirty, note)}>
      <td>{field.label}</td>
      <td class="rec-detail-name">{field.name}</td>
      <td class="rec-detail-type">{field.type}</td>
      <td class="rec-detail-value">
        <span class="rec-detail-value-row">
          <FieldValue
            field={field}
            original={original}
            raw={raw}
            onChange={(next) => props.controller.setEdit(field.name, next)}
            onFollow={(id) => props.controller.open(id)}
          />
          {note && <FlsBadge note={note} />}
        </span>
      </td>
      <FlagCells field={field} />
      <td class="rec-detail-help">
        {field.inlineHelpText && (
          <Tooltip text={field.inlineHelpText}>{field.inlineHelpText}</Tooltip>
        )}
      </td>
    </tr>
  );
}

/** A field FLS hides entirely: we know its name and type, never its value or flags. */
function HiddenRow({ field, note }: { field: HiddenField; note: FieldAccessNote }) {
  return (
    <tr class={rowClass(false, note)}>
      <td>{field.label}</td>
      <td class="rec-detail-name">{field.name}</td>
      <td class="rec-detail-type">{field.type}</td>
      <td class="rec-detail-value">
        <FlsBadge note={note} />
      </td>
      {FLAG_COLUMNS.map((col) => (
        <td key={col.key} class="query-fields-flag" />
      ))}
      <td class="rec-detail-help" />
    </tr>
  );
}

function FieldTable({ state, controller }: Props) {
  const rec = state.record.value;
  if (!rec) return null;
  const rows = rowsOf(rec);
  const visible = rows.filter((row) => matchesFilter(row, rec, state.filter.value));
  return (
    <>
      <div class="rec-detail-filter-row">
        <input
          type="text"
          class="text-input rec-detail-filter"
          placeholder={L().filterPlaceholder}
          value={state.filter.value}
          onInput={(e) => controller.setFilter(e.currentTarget.value)}
        />
        <span class="rec-detail-count">
          {visible.length} of {rows.length}
        </span>
      </div>
      <div class="rec-detail-table-wrap">
        <table class="rec-detail-table">
          <thead>
            <tr>
              <th class="rec-detail-th-label">Label</th>
              <th class="rec-detail-th-name">API Name</th>
              <th class="rec-detail-th-type">Type</th>
              <th class="rec-detail-th-value">Value</th>
              <FlagHeaders />
              <th class="rec-detail-th-help">Help Text</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) =>
              row.kind === 'field' ? (
                <FieldRow
                  key={row.field.name}
                  field={row.field}
                  state={state}
                  controller={controller}
                />
              ) : (
                <HiddenRow
                  key={`hidden:${row.field.name}`}
                  field={row.field}
                  // The host notes every hidden field; the fallback only guards the type.
                  note={rec.access[row.field.name] ?? { kind: 'hidden', grantedBy: null }}
                />
              ),
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function SaveBar({ state, controller }: Props) {
  const count = controller.dirtyCount.value;
  const review = state.review.value;
  const saving = state.savingOpId.value !== null;
  if (!state.record.value || (count === 0 && !review)) return null;

  if (review) {
    return (
      <div class="rec-detail-savebar">
        <div class="rec-detail-review-title">{L().reviewTitle}</div>
        <table class="rec-detail-review">
          <thead>
            <tr>
              <th>Field</th>
              <th>Before</th>
              <th>After</th>
            </tr>
          </thead>
          <tbody>
            {review.map((r) => (
              <tr key={r.name}>
                <td>
                  {r.label} <span class="rec-detail-subtle">({r.name})</span>
                </td>
                <td class="rec-detail-before">{r.before || L().empty}</td>
                <td class="rec-detail-after">{r.after || L().empty}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div class="feature-actions">
          <button
            type="button"
            class={saving ? 'btn btn-primary running' : 'btn btn-primary'}
            disabled={saving}
            onClick={() => controller.confirmSave()}
          >
            {L().confirmSaveBtn}
          </button>
          {saving ? (
            <button type="button" class="btn btn-ghost" onClick={() => controller.cancel()}>
              {L().cancel}
            </button>
          ) : (
            <button type="button" class="btn btn-ghost" onClick={() => controller.backToEditing()}>
              {L().backToEditing}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div class="rec-detail-savebar feature-actions">
      <span class="rec-detail-dirty-count">
        {count === 1 ? L().oneChange : L().manyChanges.replace('{n}', String(count))}
      </span>
      <button type="button" class="btn btn-primary" onClick={() => controller.startReview()}>
        {L().reviewChanges}
      </button>
      <button type="button" class="btn btn-ghost" onClick={() => controller.discardEdits()}>
        {L().discard}
      </button>
    </div>
  );
}

export function RecordDetail({ state, controller }: Props) {
  const showHint = !state.record.value && !state.loadingOpId.value && !state.error.value;
  const tabBar = useRef<HTMLDivElement>(null);
  // useLayoutEffect, NEVER useEffect: index.tsx registers the host handlers and
  // posts loadRecordDetailState right after render() returns, and both need the
  // strip to exist by then.
  useLayoutEffect(() => {
    if (tabBar.current) controller.attach({ tabBarEl: tabBar.current });
  }, []);
  return (
    <section class="card">
      <div class="query-tab-bar rec-detail-tab-bar" ref={tabBar} />
      {controller.compareView.value ? (
        <RecordCompare controller={controller} />
      ) : (
        <>
          <Toolbar state={state} controller={controller} />
          {state.error.value && <div class="error-box rec-detail-error">{state.error.value}</div>}
          {state.notice.value && (
            <div class="success-box rec-detail-notice">{state.notice.value}</div>
          )}
          {showHint && <p class="rec-detail-hint">{L().hint}</p>}
          <RecordHeader state={state} controller={controller} />
          <SaveBar state={state} controller={controller} />
          <FieldTable state={state} controller={controller} />
        </>
      )}
    </section>
  );
}

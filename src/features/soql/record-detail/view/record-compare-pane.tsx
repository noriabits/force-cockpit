// Compare mode's pane: replaces everything under the tab strip while 2–4 loaded
// records of one object are lined up. All state lives in the controller; this
// only renders its `compareView`. Read-only in v1.
//
// A chip is a CANDIDATE tab — loaded and of this object, or not loaded yet and of
// the same Id key prefix. The prefix proves only the object type, so a ticked
// record that is gone, hidden from the user, or turns out to be another object is
// shown on its chip and left out of the table, never rendered as a blank column.
import type { RecordDetailController } from './record-detail-controller';
import { Tooltip } from './tooltip';

const L = () =>
  (window as unknown as { RecordDetailLabels: Record<string, string> }).RecordDetailLabels;

type View = NonNullable<RecordDetailController['compareView']['value']>;
type Chip = View['chips'][number];

function chipClass(chip: Chip): string {
  const base = 'rec-detail-cmp-chip';
  if (chip.failed || chip.wrongObject) return `${base} ${base}--excluded`;
  if (chip.loading) return `${base} ${base}--loading`;
  return chip.selected ? `${base} ${base}--on` : base;
}

function chipNote(chip: Chip): string {
  if (chip.failed) return L().compareFailed.replace('{message}', chip.error ?? '');
  if (chip.wrongObject) return L().compareWrongObject.replace('{object}', chip.wrongObject);
  return '';
}

function Chips({ view, controller }: { view: View; controller: RecordDetailController }) {
  return (
    <div class="rec-detail-cmp-bar">
      {view.chips.map((chip) => {
        const blocked = view.atCap && !chip.selected;
        const note = chipNote(chip) || (blocked ? L().compareCap : '');
        return (
          <Tooltip key={chip.tab.recordId + chip.name} text={note} class="rec-detail-cmp-chip-wrap">
            <button
              type="button"
              class={chipClass(chip)}
              aria-disabled={blocked}
              onClick={() => !blocked && controller.toggleCompareTab(chip.tab)}
            >
              {chip.selected ? '✓ ' : ''}
              {chip.name}
              {chip.loading ? ' ⋯' : ''}
            </button>
          </Tooltip>
        );
      })}
      <button type="button" class="btn btn-ghost" onClick={() => controller.reloadCompare()}>
        {L().compareReload}
      </button>
      <button type="button" class="btn btn-ghost" onClick={() => controller.exitCompare()}>
        {L().compareExit}
      </button>
    </div>
  );
}

function CompareTable({ view, controller }: { view: View; controller: RecordDetailController }) {
  const { comparison, columnTabs } = view;
  return (
    <div class="rec-detail-table-wrap">
      <table class="rec-detail-table rec-detail-table--cmp">
        <thead>
          <tr>
            <th>{L().compareFieldHeader}</th>
            {comparison.columns.map((col, i) => (
              <th key={col.id}>
                <Tooltip text={i === 0 ? L().compareBaseline : L().compareFocusTab}>
                  <button
                    type="button"
                    class="rec-detail-cmp-head"
                    onClick={() => controller.focusCompareTab(columnTabs[i])}
                  >
                    {col.name}
                  </button>
                </Tooltip>
                <div class="rec-detail-id">{col.id}</div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {comparison.rows.map((row) => (
            <tr
              key={row.name}
              class={row.differs ? 'rec-detail-tr rec-detail-tr--cmp-differs' : 'rec-detail-tr'}
            >
              <td>
                {row.label} <span class="rec-detail-subtle">({row.name})</span>
              </td>
              {row.values.map((value, i) => (
                <td
                  key={comparison.columns[i].id}
                  class={row.differsFromFirst[i] ? 'rec-detail-cmp-cell--differs' : undefined}
                  title={value}
                >
                  {value}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RecordCompare({ controller }: { controller: RecordDetailController }) {
  const view = controller.compareView.value;
  if (!view) return null;
  const { comparison } = view;
  const enough = view.columnTabs.length >= 2;
  return (
    <div class="rec-detail-cmp">
      <Chips view={view} controller={controller} />
      {enough ? (
        <>
          <div class="rec-detail-cmp-summary">
            {L()
              .compareSummary.replace('{n}', String(comparison.differing))
              .replace('{m}', String(comparison.total))}
          </div>
          <div class="rec-detail-filter-row">
            <input
              type="text"
              class="text-input rec-detail-filter"
              placeholder={L().filterPlaceholder}
              value={view.filter}
              onInput={(e) => controller.setCompareFilter(e.currentTarget.value)}
            />
            <label class="rec-detail-cmp-only">
              <input
                type="checkbox"
                checked={view.onlyDifferences}
                onChange={(e) => controller.setCompareOnlyDifferences(e.currentTarget.checked)}
              />{' '}
              {L().onlyDifferences}
            </label>
            <span class="rec-detail-count">
              {comparison.rows.length} of {comparison.shown}
            </span>
          </div>
          <CompareTable view={view} controller={controller} />
        </>
      ) : (
        <p class="rec-detail-hint rec-detail-cmp-note">{L().compareNeedTwo}</p>
      )}
    </div>
  );
}

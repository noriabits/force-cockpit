// The describe boolean-flag columns (Req/Custom/Uniq/ExtId/Filt/Sort/Grp),
// shared by the SOQL field browser and the Record Detail.
//
// One array drives both the header (`FlagTh`) and every row (`FlagCells`) —
// mapping over the same list for both is what keeps a header and its cells
// from drifting apart on a column add/reorder.
//
// Each consuming bundle embeds its own copy at build time; nothing here holds
// state, so there is no signal to share across bundles. The two CSS rules
// (`.query-fields-th-flag`, `.query-fields-flag`) live in media/main.css for
// the same reason: two features render them.
import { useLayoutEffect, useRef } from 'preact/hooks';

const win = window as unknown as {
  __setTooltip: (el: Element, text: string) => void;
};

type FlagKey =
  | 'required'
  | 'custom'
  | 'unique'
  | 'externalId'
  | 'filterable'
  | 'sortable'
  | 'groupable';

/** What a row must carry to fill the flag cells — any describe field projection. */
type Flagged = Record<FlagKey, boolean>;

export const FLAG_COLUMNS: { key: FlagKey; header: string; tooltip: string }[] = [
  { key: 'required', header: 'Req', tooltip: 'Required — cannot be left blank' },
  { key: 'custom', header: 'Custom', tooltip: 'Custom field' },
  { key: 'unique', header: 'Uniq', tooltip: 'Unique' },
  { key: 'externalId', header: 'ExtId', tooltip: 'External Id' },
  { key: 'filterable', header: 'Filt', tooltip: 'Usable in a SOQL WHERE clause' },
  { key: 'sortable', header: 'Sort', tooltip: 'Usable in SOQL ORDER BY' },
  { key: 'groupable', header: 'Grp', tooltip: 'Usable in SOQL GROUP BY' },
];

/**
 * A boolean-flag column header, e.g. Req/Custom/Filt — the abbreviation's full
 * meaning rides the tooltip. `__setTooltip` (media/modules/tooltip.js) rather
 * than a JSX `data-tooltip`, so `aria-label` is set alongside it as everywhere else.
 */
function FlagTh({ label, tooltip }: { label: string; tooltip: string }) {
  const ref = useRef<HTMLTableCellElement>(null);
  useLayoutEffect(() => {
    if (ref.current) win.__setTooltip(ref.current, tooltip);
  }, [tooltip]);
  return (
    <th class="query-fields-th-flag" ref={ref}>
      {label}
    </th>
  );
}

/** Every flag header, in column order. */
export function FlagHeaders() {
  return (
    <>
      {FLAG_COLUMNS.map((col) => (
        <FlagTh key={col.key} label={col.header} tooltip={col.tooltip} />
      ))}
    </>
  );
}

/** One row's flag cells: a ✓ or nothing, in the same order as `FlagHeaders`. */
export function FlagCells({ field }: { field: Flagged }) {
  return (
    <>
      {FLAG_COLUMNS.map((col) => (
        <td key={col.key} class="query-fields-flag">
          {field[col.key] ? '✓' : ''}
        </td>
      ))}
    </>
  );
}

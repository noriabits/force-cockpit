// @ts-check
// Renders every SOQL statement paired with its query plan (SOQL_EXECUTE_EXPLAIN)
// as a sortable table, rated so a poorly-performing query is obvious without
// reading raw log lines one by one. Rating criteria (see parsing/queryPlan.ts):
// a full table scan is always 'critical' regardless of today's cost estimate;
// a plan Salesforce itself estimates as non-selective (relativeCost >= 1) is a
// 'warning'; an indexed, selective plan is 'good'; a query with no captured
// explain plan (custom metadata, some system objects) is 'unknown'.
import { sortRows } from '../../../shared/view/table-sort';

/** @type {Record<string, string>} */
const RATING_LABEL = {
  critical: 'Full scan',
  warning: 'Not selective',
  good: 'Selective',
  unknown: 'Unknown',
};
/** @type {Record<string, number>} */
const RATING_ORDER = { critical: 0, warning: 1, unknown: 2, good: 3 };
/** [header label, sortable-column index into cellsOf(), default ascending, tooltip] */
const COLUMNS = [
  ['Rating', 0, true, null],
  ['Line', 1, true, null],
  ['Op', 2, true, 'How the plan resolves the query: TableScan (no index), Index, or Other.'],
  ['Object', 3, true, null],
  ['Indexed on', 4, true, 'The indexed field(s) the plan used, if any.'],
  [
    'Cost',
    5,
    false,
    "Salesforce's own selectivity estimate for this plan — below 1 is considered selective.",
  ],
  [
    'Est. rows',
    6,
    false,
    "The plan's estimate of how many rows THIS QUERY will return — from Salesforce's internal statistics, not a live count.",
  ],
  [
    'Object rows',
    7,
    false,
    "The plan's estimate of the TOTAL rows on the whole object (unrelated to this query's filter) — also from statistics, which are refreshed periodically and can be stale.",
  ],
  [
    'Rows',
    8,
    false,
    'The ACTUAL number of rows this query returned when it ran — ground truth, unlike the two estimates to its left.',
  ],
  ['Query', 9, true, null],
];

/**
 * @param {{ escapeHtml: (s: string) => string, onJumpToLine: (lineNo: number) => void }} ctx
 */
export function createQueryPlanTable(ctx) {
  const { escapeHtml } = ctx;
  // Worst (by rating, then cost) first by default.
  let sortCol = 0;
  let sortAsc = true;

  function cellsOf(/** @type {any} */ plan) {
    return [
      String(RATING_ORDER[plan.rating]),
      String(plan.sourceLine ?? plan.lineNo),
      plan.operation,
      plan.object ?? '',
      plan.fieldsUsed.join(', '),
      plan.relativeCost === null ? '' : String(plan.relativeCost),
      plan.cardinality === null ? '' : String(plan.cardinality),
      plan.sobjectCardinality === null ? '' : String(plan.sobjectCardinality),
      plan.rows === null ? '' : String(plan.rows),
      plan.text,
    ];
  }

  /**
   * @param {string} icon
   * @param {string} tooltip
   * @param {() => void} onClick
   */
  function buildActionButton(icon, tooltip, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-ghost btn-icon';
    btn.textContent = icon;
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      onClick();
    });
    /** @type {any} */ (window).__setTooltip?.(btn, tooltip);
    return btn;
  }

  function buildCopyButton(/** @type {any} */ plan) {
    const btn = buildActionButton('⧉', 'Copy query', () => {
      const original = btn.textContent;
      navigator.clipboard
        .writeText(plan.text)
        .then(() => {
          btn.textContent = '✓';
          setTimeout(() => {
            btn.textContent = original;
          }, 1200);
        })
        .catch(() => {});
    });
    return btn;
  }

  function buildRow(/** @type {any} */ plan) {
    const tr = document.createElement('tr');
    tr.className = `dbg-query-row dbg-query-row--${plan.rating}`;

    const actionsCell = document.createElement('td');
    actionsCell.className = 'dbg-query-actions';
    actionsCell.appendChild(buildCopyButton(plan));
    actionsCell.appendChild(
      buildActionButton('↳', 'Go to line', () => ctx.onJumpToLine(plan.lineNo)),
    );
    tr.appendChild(actionsCell);

    const ratingCell = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `dbg-rating-badge dbg-rating-badge--${plan.rating}`;
    badge.textContent = RATING_LABEL[plan.rating];
    ratingCell.appendChild(badge);
    tr.appendChild(ratingCell);

    // One cell per COLUMNS entry after Rating (Line…Rows) — must stay in sync
    // with that list, or every column past the mismatch silently shifts.
    const cells = [
      String(plan.sourceLine ?? plan.lineNo),
      plan.operation,
      plan.object ?? '—',
      plan.fieldsUsed.join(', ') || '—',
      plan.relativeCost === null ? '—' : String(plan.relativeCost),
      plan.cardinality === null ? '—' : String(plan.cardinality),
      plan.sobjectCardinality === null ? '—' : String(plan.sobjectCardinality),
      plan.rows === null ? '—' : String(plan.rows),
    ];
    for (const value of cells) {
      const td = document.createElement('td');
      td.textContent = value;
      tr.appendChild(td);
    }

    const queryCell = document.createElement('td');
    queryCell.className = 'dbg-query-text';
    queryCell.textContent = plan.text;
    tr.appendChild(queryCell);

    return tr;
  }

  function build(/** @type {HTMLElement} */ container, /** @type {any[]} */ plans) {
    container.innerHTML = '';
    if (!plans.length) {
      container.innerHTML = `<div class="dbg-empty">${escapeHtml('No SOQL statements in this log.')}</div>`;
      return;
    }

    const legend = document.createElement('div');
    legend.className = 'dbg-query-legend';
    legend.innerHTML =
      '<span class="dbg-rating-badge dbg-rating-badge--critical">Full scan</span> no index used — degrades as the object grows · ' +
      '<span class="dbg-rating-badge dbg-rating-badge--warning">Not selective</span> Salesforce estimates relativeCost ≥ 1 · ' +
      '<span class="dbg-rating-badge dbg-rating-badge--good">Selective</span> indexed and cost &lt; 1 · ' +
      '<span class="dbg-rating-badge dbg-rating-badge--unknown">Unknown</span> no explain plan captured' +
      "<br>Est. rows / Object rows are the query planner's estimates from (possibly stale) statistics — Rows is what the query actually returned.";
    container.appendChild(legend);

    const wrap = document.createElement('div');
    wrap.className = 'dbg-query-table-scroll';
    const table = document.createElement('table');
    table.className = 'results-table dbg-query-table';

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    // Always first, never sortable — kept outside COLUMNS so it can't drift
    // out of sync with cellsOf()'s positional indices (see buildRow).
    headRow.appendChild(document.createElement('th'));
    COLUMNS.forEach(([label, index, asc, tooltip]) => {
      const th = document.createElement('th');
      th.className = 'dbg-query-sortable-th';
      th.textContent =
        /** @type {string} */ (label) + (sortCol === index ? (sortAsc ? ' ▲' : ' ▼') : '');
      if (tooltip) /** @type {any} */ (window).__setTooltip?.(th, tooltip);
      th.addEventListener('click', () => {
        if (sortCol === index) sortAsc = !sortAsc;
        else {
          sortCol = /** @type {number} */ (index);
          sortAsc = /** @type {boolean} */ (asc);
        }
        build(container, plans);
      });
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const byRow = new Map();
    const rows = plans.map((/** @type {any} */ plan) => {
      const row = cellsOf(plan);
      byRow.set(row, plan);
      return row;
    });
    const sorted = sortRows(rows, sortCol, sortAsc).map((row) => byRow.get(row));

    const tbody = document.createElement('tbody');
    for (const plan of sorted) tbody.appendChild(buildRow(plan));
    table.appendChild(tbody);

    wrap.appendChild(table);
    container.appendChild(wrap);
  }

  return {
    /**
     * @param {HTMLElement} container
     * @param {any[]} plans
     */
    render(container, plans) {
      build(container, plans);
    },
  };
}

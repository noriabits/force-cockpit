// @vitest-environment jsdom
//
// Pins the long-value handling in the monitoring table: a query selecting a
// long text area field used to render its full value in every row, which made
// the table unreadable and pushed it past the panel edge. Cells are now clamped
// to one line by CSS and unclamped on click, so what the renderer must get
// right is the tagging (which cells are clamped, and their tooltip) and the
// click routing (a record-id link still opens the record, it does not expand).
import { describe, expect, it, vi } from 'vitest';

const { createTableRenderer } = await import('./table-rendering');

const labels = {
  placeholderTableFilter: 'Filter',
  statusNoData: 'No data',
  statusNoMatchingRows: 'No matching rows',
  statusRows: (n: number) => `${n} rows`,
  statusFilteredRows: (n: number, total: number) => `${n} of ${total}`,
};

const SHORT = 'Closed Won';
const LONG = 'x'.repeat(200);

function render(rows: (string | null)[][], columnLabels = ['Id', 'Description']) {
  const vscode = { postMessage: vi.fn() };
  const grid = document.createElement('div');
  const renderer = createTableRenderer({
    grid,
    labels,
    setCardStatus: () => {},
    vscode,
  });
  const wrapper = document.createElement('div');
  wrapper.className = 'monitoring-table-wrapper';
  document.body.appendChild(wrapper);
  renderer.renderTableInEl(wrapper, { columnLabels, rows, totalRows: rows.length });
  return { wrapper, vscode };
}

describe('monitoring table long values', () => {
  it('clamps only the values too long to fit, and puts the full text in the tooltip', () => {
    const { wrapper } = render([[SHORT, LONG]]);
    const cells = wrapper.querySelectorAll('.monitoring-table-td');

    expect(cells[0].classList.contains('monitoring-table-td--clamped')).toBe(false);
    expect(cells[0].getAttribute('title')).toBeNull();
    expect(cells[1].classList.contains('monitoring-table-td--clamped')).toBe(true);
    expect(cells[1].getAttribute('title')).toBe(LONG);
  });

  it('leaves a null cell alone', () => {
    const { wrapper } = render([[SHORT, null]]);
    const cells = wrapper.querySelectorAll('.monitoring-table-td');

    expect(cells[1].classList.contains('monitoring-table-td--clamped')).toBe(false);
    expect(cells[1].getAttribute('title')).toBeNull();
  });

  it('expands a clamped cell on click and collapses it again', () => {
    const { wrapper } = render([[SHORT, LONG]]);
    const cell = wrapper.querySelectorAll('.monitoring-table-td')[1];

    cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cell.classList.contains('monitoring-table-td--expanded')).toBe(true);

    cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cell.classList.contains('monitoring-table-td--expanded')).toBe(false);
  });

  it('still opens the record when a record-id link is clicked', () => {
    const recordId = '001000000000001AAA';
    const { wrapper, vscode } = render([[recordId, LONG]]);
    const link = wrapper.querySelector('.monitoring-record-link') as HTMLElement;

    link.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(vscode.postMessage).toHaveBeenCalledWith({ type: 'openRecord', recordId });
    // The click must not also expand the cell it happened inside.
    const cell = wrapper.querySelectorAll('.monitoring-table-td')[0];
    expect(cell.classList.contains('monitoring-table-td--expanded')).toBe(false);
  });
});

// @vitest-environment jsdom
//
// Pins how the results table presents a long value. It used to hang a hover
// tooltip off every non-null cell; long text area fields (Description, an Apex
// error Message) are wanted for reading and copying, which a tooltip can't do,
// so a long cell is now clamped by CSS and unwrapped by a click instead.
//
// The raw value moved with it: the per-cell copy button used to read it back
// off the tooltip's own `data-tooltip` attribute, so the tests below also pin
// that the cell still carries the un-ellipsized value for it.
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { createResultsTable } = await import('./results-table');

const SHORT = 'Closed Won';
const LONG = 'x'.repeat(200);

function setup(records: Record<string, unknown>[]) {
  document.body.innerHTML = '';
  const wrapper = document.createElement('div');
  wrapper.className = 'table-wrapper';
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);
  wrapper.appendChild(table);
  document.body.appendChild(wrapper);

  const vscode = { postMessage: vi.fn() };
  const api = createResultsTable({
    thead,
    tbody,
    meta: document.createElement('div'),
    filterInput: document.createElement('input'),
    counterEl: document.createElement('span'),
    vscode,
    escapeHtml: (s: unknown) => String(s),
  });
  api.setData(records, records.length);
  return { cells: tbody.querySelectorAll('td'), tbody, vscode };
}

function click(el: Element) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

beforeEach(() => {
  // Set by media/modules/tooltip.js, which doesn't run under jsdom; the header
  // and copy buttons still call it.
  (window as unknown as { __setTooltip: () => void }).__setTooltip = () => {};
});

describe('results table long values', () => {
  it('clamps only the values too long to fit', () => {
    const { cells } = setup([{ Stage: SHORT, Description: LONG }]);

    expect(cells[0].classList.contains('fc-cell-clamped')).toBe(false);
    expect(cells[1].classList.contains('fc-cell-clamped')).toBe(true);
  });

  it('keeps the raw value on the cell for the copy button, and none on a null', () => {
    const { cells } = setup([{ Description: LONG, Notes: null }]);

    expect(cells[0].getAttribute('data-cell-value')).toBe(LONG);
    expect(cells[1].getAttribute('data-cell-value')).toBeNull();
    expect(cells[1].classList.contains('fc-cell-clamped')).toBe(false);
  });

  it('hangs no tooltip off the cells any more', () => {
    const { cells } = setup([{ Description: LONG }]);

    expect(cells[0].getAttribute('data-tooltip')).toBeNull();
    expect(cells[0].hasAttribute('data-tooltip-wrap')).toBe(false);
  });

  it('expands a clamped cell on click and collapses it again', () => {
    const { cells } = setup([{ Description: LONG }]);

    click(cells[0]);
    expect(cells[0].classList.contains('fc-cell-expanded')).toBe(true);

    click(cells[0]);
    expect(cells[0].classList.contains('fc-cell-expanded')).toBe(false);
  });

  it('still opens the record when a record-id link is clicked', () => {
    const recordId = '001000000000001AAA';
    const { cells, tbody, vscode } = setup([{ Id: recordId, Description: LONG }]);

    click(tbody.querySelector('.query-record-link') as HTMLElement);

    expect(vscode.postMessage).toHaveBeenCalledWith({ type: 'openRecord', recordId });
    expect(cells[0].classList.contains('fc-cell-expanded')).toBe(false);
  });
});

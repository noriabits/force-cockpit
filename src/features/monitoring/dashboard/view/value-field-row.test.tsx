// @vitest-environment jsdom
// Component-level test for the value-field row.
//
// The "never remove the last row" guard used to live inside a click listener
// that queried `container.querySelectorAll('.monitoring-value-field-row')` —
// only reachable by driving real DOM, so it was never covered. As a component
// it is just a prop.
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import { ValueFieldRow, emptyDraft } from './edit-form-fields';

// Tooltips come from a webview global (media/modules/tooltip.js) that has no
// jsdom equivalent. The stub records what was labelled, because every control
// in this row is an unlabelled cell in a dense grid — the tooltip IS the label,
// and the Preact port silently dropped it from the two <select>s.
const tooltips = new Map<Element, string>();
(window as unknown as { __setTooltip: (el: Element, text: string) => void }).__setTooltip = (
  el,
  text,
) => {
  tooltips.set(el, text);
};

const labels = {
  labelValueFieldApi: 'API name',
  labelValueFieldLabel: 'Label',
  labelValueFieldFormat: 'Format',
  labelThresholdCondition: 'Condition',
  placeholderValueFieldApi: 'Cnt',
  placeholderValueFieldLabel: 'Count',
  placeholderThreshold: 'Threshold',
  btnRemoveValueField: '×',
  btnRemoveValueFieldTooltip: 'Remove',
  formatOptions: { '': 'None', currency: 'Currency', percent: 'Percent' },
  conditionOptions: { above: 'Above', below: 'Below' },
};

function renderRow(over: { canRemove?: boolean } = {}) {
  const onRemove = vi.fn();
  const onPatch = vi.fn();
  const utils = render(
    <ValueFieldRow
      row={{ ...emptyDraft(), field: 'Cnt', label: 'Count' }}
      labels={labels as never}
      canRemove={over.canRemove ?? true}
      onPatch={onPatch}
      onRemove={onRemove}
    />,
  );
  return { ...utils, onRemove, onPatch };
}

describe('ValueFieldRow', () => {
  // Not a trailing `cleanup()` per test: a failing assertion throws before it,
  // leaking the mounted DOM into the next test.
  afterEach(cleanup);
  it('removes the row when more than one exists', () => {
    const { container, onRemove } = renderRow({ canRemove: true });
    fireEvent.click(container.querySelector('.monitoring-remove-vf-btn')!);
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it('refuses to remove the only remaining row', () => {
    const { container, onRemove } = renderRow({ canRemove: false });
    fireEvent.click(container.querySelector('.monitoring-remove-vf-btn')!);
    expect(onRemove).not.toHaveBeenCalled();
  });

  it('labels every control — all six, including both selects', () => {
    tooltips.clear();
    const { container } = renderRow();
    const labelled = (sel: string) => tooltips.get(container.querySelector(sel)!);

    expect(labelled('input[type="text"]')).toBe(labels.labelValueFieldApi);
    expect(labelled('.monitoring-vf-format-select')).toBe(labels.labelValueFieldFormat);
    expect(labelled('.monitoring-vf-threshold-input')).toBe(labels.placeholderThreshold);
    expect(labelled('.monitoring-vf-condition-select')).toBe(labels.labelThresholdCondition);
    expect(labelled('.monitoring-remove-vf-btn')).toBe(labels.btnRemoveValueFieldTooltip);
    // The second text input is the display label.
    expect(tooltips.get(container.querySelectorAll('input[type="text"]')[1])).toBe(
      labels.labelValueFieldLabel,
    );
  });

  it('reports edits through onPatch rather than mutating the DOM', () => {
    const { container, onPatch } = renderRow();
    const apiInput = container.querySelectorAll('input')[0];
    fireEvent.input(apiInput, { target: { value: 'Amount' } });
    expect(onPatch).toHaveBeenCalledWith({ field: 'Amount' });
  });
});

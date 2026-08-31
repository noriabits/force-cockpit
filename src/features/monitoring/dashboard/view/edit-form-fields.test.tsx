// First webview tests in the codebase.
//
// These are possible only because the migration moved form state out of the
// DOM: `draftsToValueFields` is now a pure function over the edit rows, where
// it used to be `readValueFields()` walking `querySelectorAll` over live nodes.
// That function encodes several rules that were previously untested and easy to
// break — which is exactly why it is the thing worth pinning down.
import { describe, expect, it } from 'vitest';
import { draftsToValueFields, emptyDraft, toDraft } from './edit-form-fields';

function draft(over: Partial<ReturnType<typeof emptyDraft>> = {}) {
  return { ...emptyDraft(), ...over };
}

describe('draftsToValueFields', () => {
  it('drops rows with no API name', () => {
    const rows = [
      draft({ field: 'Cnt', label: 'Count' }),
      draft({ field: '   ', label: 'Orphan' }),
    ];
    expect(draftsToValueFields(rows)).toEqual([{ field: 'Cnt', label: 'Count' }]);
  });

  it('defaults the label to the field name', () => {
    expect(draftsToValueFields([draft({ field: 'Amount' })])).toEqual([
      { field: 'Amount', label: 'Amount' },
    ]);
  });

  it('trims both the field and the label', () => {
    expect(draftsToValueFields([draft({ field: '  Amount  ', label: '  Total  ' })])).toEqual([
      { field: 'Amount', label: 'Total' },
    ]);
  });

  it('omits format when none is picked', () => {
    const [vf] = draftsToValueFields([draft({ field: 'Cnt' })]);
    expect('format' in vf).toBe(false);
  });

  it('carries the condition only when a threshold actually parses', () => {
    const [withThreshold] = draftsToValueFields([
      draft({ field: 'Cnt', threshold: '100', thresholdCondition: 'below' }),
    ]);
    expect(withThreshold).toMatchObject({ threshold: 100, thresholdCondition: 'below' });

    // A blank threshold must not smuggle a condition through — the host reads
    // `thresholdCondition` only alongside a threshold, and a stray one would
    // round-trip into the saved YAML as a meaningless key.
    const [blank] = draftsToValueFields([
      draft({ field: 'Cnt', threshold: '   ', thresholdCondition: 'below' }),
    ]);
    expect('threshold' in blank).toBe(false);
    expect('thresholdCondition' in blank).toBe(false);
  });

  it('ignores a threshold that is not a number', () => {
    const [vf] = draftsToValueFields([draft({ field: 'Cnt', threshold: 'abc' })]);
    expect('threshold' in vf).toBe(false);
  });

  it('keeps a zero threshold — 0 is a real bound, not "unset"', () => {
    const [vf] = draftsToValueFields([draft({ field: 'Cnt', threshold: '0' })]);
    expect(vf.threshold).toBe(0);
  });
});

describe('toDraft', () => {
  it('round-trips a saved value field back through draftsToValueFields', () => {
    const saved = {
      field: 'Amount',
      label: 'Total',
      format: 'currency' as const,
      threshold: 50,
      thresholdCondition: 'above' as const,
    };
    expect(draftsToValueFields([toDraft(saved)])).toEqual([saved]);
  });

  it('gives every row a distinct key so list edits do not collide', () => {
    const a = toDraft({ field: 'A', label: 'A' });
    const b = toDraft({ field: 'B', label: 'B' });
    expect(a.key).not.toBe(b.key);
  });
});

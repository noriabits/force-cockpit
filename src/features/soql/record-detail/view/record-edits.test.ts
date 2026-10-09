import { describe, expect, it } from 'vitest';
import type { RecordDetailField } from '../../../../shared/protocol';
import {
  buildChanges,
  coerceRawValue,
  displayValue,
  editorKindFor,
  isDirty,
  toRawValue,
} from './record-edits';

function field(
  name: string,
  type: string,
  extra: Partial<RecordDetailField> = {},
): RecordDetailField {
  return {
    name,
    label: name,
    type,
    referenceTo: [],
    picklistValues: [],
    inlineHelpText: null,
    required: false,
    custom: false,
    unique: false,
    externalId: false,
    filterable: true,
    sortable: true,
    groupable: true,
    updateable: true,
    calculated: false,
    ...extra,
  };
}

describe('editorKindFor', () => {
  it('maps writable types to their input', () => {
    expect(editorKindFor(field('A', 'boolean'))).toBe('checkbox');
    expect(editorKindFor(field('A', 'picklist'))).toBe('picklist');
    expect(editorKindFor(field('A', 'currency'))).toBe('number');
    expect(editorKindFor(field('A', 'int'))).toBe('number');
    expect(editorKindFor(field('A', 'date'))).toBe('date');
    expect(editorKindFor(field('A', 'datetime'))).toBe('datetime');
    expect(editorKindFor(field('A', 'textarea'))).toBe('textarea');
    expect(editorKindFor(field('A', 'reference'))).toBe('text');
    expect(editorKindFor(field('A', 'multipicklist'))).toBe('text');
  });

  it('is read-only when not updateable, calculated, or structurally uneditable', () => {
    expect(editorKindFor(field('A', 'string', { updateable: false }))).toBe('readonly');
    expect(editorKindFor(field('A', 'string', { updateable: undefined }))).toBe('readonly');
    expect(editorKindFor(field('A', 'currency', { calculated: true }))).toBe('readonly');
    expect(editorKindFor(field('A', 'address'))).toBe('readonly');
    expect(editorKindFor(field('A', 'base64'))).toBe('readonly');
  });
});

describe('toRawValue / displayValue', () => {
  it('turns null into an empty input and a boolean into a checkbox state', () => {
    expect(toRawValue(field('A', 'string'), null)).toBe('');
    expect(toRawValue(field('A', 'boolean'), true)).toBe(true);
    expect(toRawValue(field('A', 'boolean'), null)).toBe(false);
    expect(toRawValue(field('A', 'double'), 12.5)).toBe('12.5');
  });

  it('shows a datetime in local time at minute precision', () => {
    const raw = toRawValue(field('A', 'datetime'), '2024-03-05T10:20:30.000+0000');
    expect(raw).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it('serializes compound values rather than printing [object Object]', () => {
    const address = { city: 'Madrid' };
    expect(displayValue(field('A', 'address'), address)).toBe('{"city":"Madrid"}');
  });
});

describe('coerceRawValue', () => {
  it('sends null for a cleared field, never an empty string', () => {
    expect(coerceRawValue(field('A', 'string'), '')).toEqual({ value: null });
    expect(coerceRawValue(field('A', 'currency'), '   ')).toEqual({ value: null });
    expect(coerceRawValue(field('A', 'date'), '')).toEqual({ value: null });
  });

  it('parses numbers and reports a bad one by label', () => {
    expect(coerceRawValue(field('Amount', 'currency'), ' 1500.25 ')).toEqual({ value: 1500.25 });
    expect(coerceRawValue(field('Amount', 'currency'), '1,5')).toEqual({
      error: 'Amount: "1,5" is not a number',
    });
  });

  it('keeps booleans and dates as given, and converts a datetime to ISO UTC', () => {
    expect(coerceRawValue(field('A', 'boolean'), false)).toEqual({ value: false });
    expect(coerceRawValue(field('A', 'date'), '2024-03-05')).toEqual({ value: '2024-03-05' });
    const out = coerceRawValue(field('A', 'datetime'), '2024-03-05T10:20');
    expect(out).toEqual({ value: new Date('2024-03-05T10:20').toISOString() });
  });
});

describe('isDirty', () => {
  it('treats an untouched datetime as clean, despite the lossy round trip', () => {
    const f = field('A', 'datetime');
    const original = '2024-03-05T10:20:30.123+0000';
    expect(isDirty(f, original, toRawValue(f, original))).toBe(false);
  });
});

describe('buildChanges', () => {
  const fields = [
    field('Name', 'string'),
    field('Amount', 'currency'),
    field('IsActive__c', 'boolean'),
    field('Total__c', 'currency', { calculated: true }),
    field('Phone', 'phone'),
  ];
  const values = { Name: 'Acme', Amount: 100, IsActive__c: false, Total__c: 5, Phone: '555' };

  it('includes only fields whose value actually changed', () => {
    const { changes, review, errors } = buildChanges(fields, values, {
      Name: 'Acme', // edited back to the original — not a change
      Amount: '250',
      IsActive__c: true,
      Phone: '',
    });
    expect(errors).toEqual([]);
    expect(changes).toEqual({ Amount: 250, IsActive__c: true, Phone: null });
    expect(review).toEqual([
      { name: 'Amount', label: 'Amount', before: '100', after: '250' },
      { name: 'IsActive__c', label: 'IsActive__c', before: 'false', after: 'true' },
      { name: 'Phone', label: 'Phone', before: '555', after: '' },
    ]);
  });

  it('never sends an edit to a field the user may not write', () => {
    const { changes } = buildChanges(fields, values, { Total__c: '999' });
    expect(changes).toEqual({});
  });

  it('collects coercion errors instead of sending them', () => {
    const { changes, errors } = buildChanges(fields, values, { Amount: 'lots', Name: 'New' });
    expect(changes).toEqual({ Name: 'New' });
    expect(errors).toEqual(['Amount: "lots" is not a number']);
  });
});

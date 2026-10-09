import { describe, expect, it } from 'vitest';
import { accessSummary, accessTooltip } from './access-note';

const L: Record<string, string> = {
  flsReadOnly: 'READ-ONLY.',
  flsHidden: 'HIDDEN.',
  grantsEdit: 'Edit by: {list}.',
  grantsRead: 'Read by: {list}.',
  grantsNoneEdit: 'Nobody grants Edit.',
  grantsNoneRead: 'Nobody grants Read.',
  grantsUnknown: 'Could not check.',
  summaryReadOnly: '{n} not editable',
  summaryHidden: '{n} hidden',
  summarySuffix: 'by FLS',
};

describe('accessTooltip', () => {
  it('names who grants the missing access level', () => {
    expect(accessTooltip({ kind: 'readOnly', grantedBy: ['A (Permission Set)', 'B'] }, L)).toBe(
      'READ-ONLY. Edit by: A (Permission Set), B.',
    );
    expect(accessTooltip({ kind: 'hidden', grantedBy: ['C'] }, L)).toBe('HIDDEN. Read by: C.');
  });

  it('tells "nobody grants it" apart from "could not check"', () => {
    expect(accessTooltip({ kind: 'readOnly', grantedBy: [] }, L)).toBe(
      'READ-ONLY. Nobody grants Edit.',
    );
    expect(accessTooltip({ kind: 'hidden', grantedBy: [] }, L)).toBe('HIDDEN. Nobody grants Read.');
    expect(accessTooltip({ kind: 'readOnly', grantedBy: null }, L)).toBe(
      'READ-ONLY. Could not check.',
    );
  });
});

describe('accessSummary', () => {
  it('counts each kind, omitting a zero', () => {
    const ro = { kind: 'readOnly' as const, grantedBy: null };
    const hid = { kind: 'hidden' as const, grantedBy: null };
    expect(accessSummary({ a: ro, b: ro, c: hid }, L)).toBe('🔒 2 not editable · 1 hidden by FLS');
    expect(accessSummary({ a: hid }, L)).toBe('🔒 1 hidden by FLS');
    expect(accessSummary({}, L)).toBe('');
  });
});

import { describe, expect, it } from 'vitest';
import {
  belongsToBase,
  cloneName,
  deriveName,
  firstFreeName,
  nameBase,
  shouldRevertToAuto,
} from './tab-naming';

describe('firstFreeName', () => {
  it('takes the bare base when nothing else holds it', () => {
    expect(firstFreeName('Account', ['Contact'])).toBe('Account');
  });

  it('walks up to the first free slot rather than the next number', () => {
    expect(firstFreeName('Account', ['Account', 'Account (2)'])).toBe('Account (1)');
  });

  it('matches taken names case-insensitively', () => {
    expect(firstFreeName('Account', ['account'])).toBe('Account (1)');
  });
});

describe('nameBase', () => {
  it('strips a dedup suffix', () => {
    expect(nameBase('Account (3)')).toBe('Account');
  });

  it('leaves a name with no suffix alone', () => {
    expect(nameBase('Account')).toBe('Account');
  });
});

describe('belongsToBase', () => {
  it('accepts the bare and the suffixed form', () => {
    expect(belongsToBase('Account', 'Account')).toBe(true);
    expect(belongsToBase('Account (2)', 'account')).toBe(true);
  });

  it('rejects a different base and a lookalike', () => {
    expect(belongsToBase('Contact', 'Account')).toBe(false);
    expect(belongsToBase('Account copy', 'Account')).toBe(false);
  });

  it('treats a regex-special base as literal text', () => {
    expect(belongsToBase('GET Request', 'GET Request')).toBe(true);
    expect(belongsToBase('a.c', 'a+c')).toBe(false);
  });
});

describe('deriveName', () => {
  it('keeps a current name that already belongs to the base, so edits never renumber', () => {
    expect(deriveName('Account', ['Account'], 'Account (1)')).toBe('Account (1)');
  });

  it('renames once the base changes', () => {
    expect(deriveName('Contact', [], 'Account')).toBe('Contact');
  });

  it('dedupes when there is no current name to keep', () => {
    expect(deriveName('Account', ['Account'])).toBe('Account (1)');
  });
});

describe('shouldRevertToAuto', () => {
  it('holds an adopted label while the base still matches', () => {
    expect(shouldRevertToAuto('Account', 'Account')).toBe(false);
    expect(shouldRevertToAuto('account', 'Account')).toBe(false);
  });

  it('lets the label lapse once the tab targets something else', () => {
    expect(shouldRevertToAuto('Lead', 'Account')).toBe(true);
  });

  it('never reverts a name with no anchor — that one was typed by hand', () => {
    expect(shouldRevertToAuto('Lead', null)).toBe(false);
    expect(shouldRevertToAuto('Lead', undefined)).toBe(false);
    expect(shouldRevertToAuto('Lead', '')).toBe(false);
  });
});

describe('cloneName', () => {
  it('renumbers an auto name from its base', () => {
    expect(cloneName('Account (1)', ['Account', 'Account (1)'], true)).toBe('Account (2)');
  });

  // A hand-typed "Invoices (2024)" is the name they chose, not a dedup suffix.
  it('keeps a hand-typed trailing (n) as part of the name', () => {
    expect(cloneName('Invoices (2024)', ['Invoices (2024)'], false)).toBe('Invoices (2024) (1)');
  });
});

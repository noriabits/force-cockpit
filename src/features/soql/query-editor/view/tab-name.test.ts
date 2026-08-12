import { describe, expect, it } from 'vitest';
import { baseNameFor, deriveTabName, isLegacyAutoName, queryObjectName } from './tab-name';

describe('queryObjectName', () => {
  it('extracts the object after FROM', () => {
    expect(queryObjectName('SELECT Id FROM Account')).toBe('Account');
  });

  it('is case-insensitive on the FROM keyword', () => {
    expect(queryObjectName('select Id from Order')).toBe('Order');
  });

  it('handles newlines and extra whitespace before the object', () => {
    expect(queryObjectName('SELECT Id\nFROM   Contact')).toBe('Contact');
  });

  it('keeps the exact casing of a custom object', () => {
    expect(queryObjectName('SELECT Id FROM Invoice_Line__c')).toBe('Invoice_Line__c');
  });

  it('prefers the outer FROM over a subquery FROM', () => {
    expect(queryObjectName('SELECT Id, (SELECT Id FROM Contacts) FROM Account')).toBe('Account');
  });

  it('ignores a subquery FROM when there is no outer FROM yet', () => {
    // Degenerate/incomplete query: only a subquery FROM exists so far.
    expect(queryObjectName('SELECT Id, (SELECT Id FROM Contacts)')).toBeNull();
  });

  it('returns null when there is no FROM yet', () => {
    expect(queryObjectName('SELECT Id ')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(queryObjectName('')).toBeNull();
  });
});

describe('baseNameFor', () => {
  it('is the FROM object when present', () => {
    expect(baseNameFor('SELECT Id FROM Account')).toBe('Account');
  });

  it('falls back to Query when there is no FROM object yet', () => {
    expect(baseNameFor('SELECT Id FROM ')).toBe('Query');
    expect(baseNameFor('')).toBe('Query');
  });
});

describe('deriveTabName', () => {
  it('takes the bare object name when it is free', () => {
    expect(deriveTabName('SELECT Id FROM Order', [])).toBe('Order');
  });

  it('suffixes with (1), (2)... in order as the bare name and earlier suffixes are taken', () => {
    expect(deriveTabName('SELECT Id FROM Order', ['Order'])).toBe('Order (1)');
    expect(deriveTabName('SELECT Id FROM Order', ['Order', 'Order (1)'])).toBe('Order (2)');
  });

  it('fills the first free slot, not just the next number', () => {
    // "Order (1)" was freed (its tab closed) while "Order" and "Order (2)" remain.
    expect(deriveTabName('SELECT Id FROM Order', ['Order', 'Order (2)'])).toBe('Order (1)');
  });

  it('keeps a current name that already belongs to the same base', () => {
    expect(deriveTabName('SELECT Id FROM Order WHERE Status = 1', ['Account'], 'Order')).toBe(
      'Order',
    );
    expect(deriveTabName('SELECT Id FROM Order WHERE Status = 1', ['Order'], 'Order (1)')).toBe(
      'Order (1)',
    );
  });

  it('re-derives when the FROM object changes to a different base', () => {
    expect(deriveTabName('SELECT Id FROM Account', [], 'Order')).toBe('Account');
  });

  it('falls back to Query (n) for tabs with no FROM object yet', () => {
    expect(deriveTabName('SELECT Id FROM ', ['Query'])).toBe('Query (1)');
  });

  it('treats differently-cased object names as the same base for dedup', () => {
    expect(deriveTabName('SELECT Id FROM asset', ['Asset'])).toBe('asset (1)');
    expect(deriveTabName('SELECT Id FROM ASSET', ['Asset', 'asset (1)'])).toBe('ASSET (2)');
  });

  it('keeps a current name whose case differs from the freshly-typed base', () => {
    expect(deriveTabName('SELECT Id FROM asset', ['Account'], 'Asset')).toBe('Asset');
    expect(deriveTabName('SELECT Id FROM ASSET', ['Asset'], 'Asset (1)')).toBe('Asset (1)');
  });
});

describe('isLegacyAutoName', () => {
  it('matches the old "Query N" counter names', () => {
    expect(isLegacyAutoName('Query 1')).toBe(true);
    expect(isLegacyAutoName('Query 42')).toBe(true);
  });

  it('does not match a user-chosen name or the new fallback base', () => {
    expect(isLegacyAutoName('Query')).toBe(false);
    expect(isLegacyAutoName('My saved query')).toBe(false);
    expect(isLegacyAutoName('Order')).toBe(false);
    expect(isLegacyAutoName('Order (1)')).toBe(false);
  });
});

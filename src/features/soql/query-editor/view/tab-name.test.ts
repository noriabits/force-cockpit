import { describe, expect, it } from 'vitest';
import {
  baseNameFor,
  cloneTabName,
  deriveTabName,
  isLegacyAutoName,
  queryObjectName,
} from './tab-name';

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

  it('ignores an unbalanced paren inside a string literal in an earlier subquery', () => {
    // The literal's stray "(" must not desync the paren-depth count and hide
    // the real top-level FROM that follows the subquery.
    expect(
      queryObjectName(
        "SELECT Name, (SELECT Id FROM Contacts WHERE Description LIKE '%(VIP%') FROM Account",
      ),
    ).toBe('Account');
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

describe('cloneTabName', () => {
  it('numbers a bare name to (1)', () => {
    expect(cloneTabName('asset', ['asset'], true)).toBe('asset (1)');
  });

  it('takes the next free slot when earlier ones are taken', () => {
    expect(cloneTabName('asset', ['asset', 'asset (1)'], true)).toBe('asset (2)');
  });

  it('fills a gap left by a closed tab rather than always incrementing', () => {
    expect(cloneTabName('asset', ['asset', 'asset (2)'], true)).toBe('asset (1)');
  });

  it('clones from the same base when the source is already suffixed and auto-named', () => {
    expect(cloneTabName('asset (1)', ['asset', 'asset (1)'], true)).toBe('asset (2)');
  });

  it('works for a manually-renamed tab, independent of its query', () => {
    expect(cloneTabName('My saved query', ['My saved query'], false)).toBe('My saved query (1)');
  });

  it('does not strip a manually-typed trailing "(n)" that is not a dedup suffix', () => {
    // The user renamed the tab to "Invoices (2024)" by hand — (2024) is part of
    // the name they chose, not an auto-numbering suffix, so isAutoName is false.
    expect(cloneTabName('Invoices (2024)', ['Invoices (2024)'], false)).toBe('Invoices (2024) (1)');
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

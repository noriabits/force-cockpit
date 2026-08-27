import { describe, expect, it } from 'vitest';
import {
  addFieldEdit,
  parseSelectClause,
  removeFieldEdit,
  selectedFieldSet,
} from './select-clause';

/** Apply an edit the same way the panel does, for readable assertions. */
function apply(soql: string, edit: { start: number; end: number; text: string } | null): string {
  if (!edit) return soql;
  return soql.slice(0, edit.start) + edit.text + soql.slice(edit.end);
}

describe('parseSelectClause', () => {
  it('returns null when there is no SELECT', () => {
    expect(parseSelectClause('')).toBeNull();
    expect(parseSelectClause('FROM Account')).toBeNull();
  });

  it('splits a simple field list', () => {
    const clause = parseSelectClause('SELECT Id, Name FROM Account');
    expect(clause?.items.map((i) => i.text)).toEqual(['Id', 'Name']);
  });

  it('lists end at end of text when there is no FROM yet', () => {
    const clause = parseSelectClause('SELECT Id, Name');
    expect(clause?.items.map((i) => i.text)).toEqual(['Id', 'Name']);
  });

  it('keeps a subquery as one item, not split on its inner comma-less FROM', () => {
    const clause = parseSelectClause('SELECT Id, (SELECT Id FROM Contacts) FROM Account');
    expect(clause?.items.map((i) => i.text)).toEqual(['Id', '(SELECT Id FROM Contacts)']);
  });

  it('keeps a function call with a comma inside as one item', () => {
    const clause = parseSelectClause("SELECT Id, FORMAT(Amount, 'en-US') FROM Opportunity");
    expect(clause?.items.map((i) => i.text)).toEqual(['Id', "FORMAT(Amount, 'en-US')"]);
  });

  it('ignores a FROM keyword inside a string literal', () => {
    const clause = parseSelectClause("SELECT Id, Name FROM Account WHERE Name LIKE '%FROM%'");
    expect(clause?.items.map((i) => i.text)).toEqual(['Id', 'Name']);
  });

  it('handles a multi-line query, keeping item spans exact', () => {
    const soql = 'SELECT Id,\n  Name\nFROM Account';
    const clause = parseSelectClause(soql);
    expect(clause?.items.map((i) => i.text)).toEqual(['Id', 'Name']);
    expect(clause?.items.map((i) => soql.slice(i.start, i.end))).toEqual(['Id', 'Name']);
  });

  it('reports no items for an empty list mid-edit', () => {
    expect(parseSelectClause('SELECT FROM Account')?.items).toEqual([]);
    expect(parseSelectClause('SELECT ')?.items).toEqual([]);
  });
});

describe('selectedFieldSet', () => {
  it('is case-insensitive and lowercases entries', () => {
    expect(selectedFieldSet('select id, Name from Account')).toEqual(new Set(['id', 'name']));
  });

  it('includes dotted relationship paths', () => {
    expect(selectedFieldSet('SELECT Id, Owner.Name FROM Account').has('owner.name')).toBe(true);
  });

  it('excludes a subquery, function call, or FIELDS() shorthand', () => {
    const set = selectedFieldSet('SELECT Id, (SELECT Id FROM Contacts), FIELDS(ALL) FROM Account');
    expect(set).toEqual(new Set(['id']));
  });

  it('is empty when there is no SELECT', () => {
    expect(selectedFieldSet('')).toEqual(new Set());
  });
});

describe('addFieldEdit', () => {
  it('appends after the last item', () => {
    expect(
      apply('SELECT Id FROM Account', addFieldEdit('SELECT Id FROM Account', 'Industry')),
    ).toBe('SELECT Id, Industry FROM Account');
  });

  it('preserves everything else in the query, including a multi-line layout', () => {
    const soql = 'SELECT Id,\n  Name\nFROM Account\nWHERE IsActive = true';
    const result = apply(soql, addFieldEdit(soql, 'Industry'));
    expect(result).toBe('SELECT Id,\n  Name, Industry\nFROM Account\nWHERE IsActive = true');
  });

  it('is a no-op (returns null) when the field is already present, case-insensitively', () => {
    expect(addFieldEdit('SELECT Id, Industry FROM Account', 'industry')).toBeNull();
  });

  it('fills an empty list with a leading space', () => {
    expect(apply('SELECT FROM Account', addFieldEdit('SELECT FROM Account', 'Id'))).toBe(
      'SELECT Id FROM Account',
    );
  });

  it('works when there is no FROM yet', () => {
    expect(apply('SELECT Id', addFieldEdit('SELECT Id', 'Name'))).toBe('SELECT Id, Name');
  });

  it('replaces a bare COUNT() rather than appending to it', () => {
    expect(
      apply('SELECT COUNT() FROM Account', addFieldEdit('SELECT COUNT() FROM Account', 'Id')),
    ).toBe('SELECT Id FROM Account');
  });

  it('returns null when there is no SELECT to edit', () => {
    expect(addFieldEdit('FROM Account', 'Id')).toBeNull();
  });
});

describe('removeFieldEdit', () => {
  it('removes a middle field, keeping neighbours intact', () => {
    expect(
      apply(
        'SELECT Id, Name, Industry FROM Account',
        removeFieldEdit('SELECT Id, Name, Industry FROM Account', 'Name'),
      ),
    ).toBe('SELECT Id, Industry FROM Account');
  });

  it('removes the first field', () => {
    expect(
      apply('SELECT Id, Name FROM Account', removeFieldEdit('SELECT Id, Name FROM Account', 'Id')),
    ).toBe('SELECT Name FROM Account');
  });

  it('removes the last field', () => {
    expect(
      apply(
        'SELECT Id, Name FROM Account',
        removeFieldEdit('SELECT Id, Name FROM Account', 'Name'),
      ),
    ).toBe('SELECT Id FROM Account');
  });

  it('removes a dotted relationship path', () => {
    expect(
      apply(
        'SELECT Id, Owner.Name FROM Account',
        removeFieldEdit('SELECT Id, Owner.Name FROM Account', 'Owner.Name'),
      ),
    ).toBe('SELECT Id FROM Account');
  });

  it('refuses to remove the only field', () => {
    expect(removeFieldEdit('SELECT Id FROM Account', 'Id')).toBeNull();
  });

  it('preserves a subquery when removing an unrelated field', () => {
    const soql = 'SELECT Id, Name, (SELECT Id FROM Contacts) FROM Account';
    expect(apply(soql, removeFieldEdit(soql, 'Name'))).toBe(
      'SELECT Id, (SELECT Id FROM Contacts) FROM Account',
    );
  });

  it('returns null when the field is not a bare item in the list', () => {
    expect(removeFieldEdit('SELECT Id, Name FROM Account', 'Industry')).toBeNull();
  });

  it('returns null when there is no SELECT', () => {
    expect(removeFieldEdit('FROM Account', 'Id')).toBeNull();
  });
});

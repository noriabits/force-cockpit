import { describe, expect, it } from 'vitest';
import { MAX_HIGHLIGHT_CHARS, tokenizeSoql, type SoqlToken } from './soql-tokens';

/**
 * Render the token list as `kind:text` pairs. Adjacent plain-text runs are merged
 * by the tokenizer (fewer spans in the overlay), so the surrounding whitespace is
 * trimmed here and whitespace-only runs are dropped.
 */
function slices(soql: string): string[] {
  return tokenizeSoql(soql)
    .map((t) => ({ kind: t.kind, text: soql.slice(t.start, t.end).trim() }))
    .filter((t) => t.text !== '')
    .map((t) => `${t.kind}:${t.text}`);
}

/** Tokens must tile the input exactly — no gaps, no overlaps, full coverage. */
function assertTiles(soql: string, tokens: SoqlToken[]) {
  let cursor = 0;
  for (const t of tokens) {
    expect(t.start).toBe(cursor);
    expect(t.end).toBeGreaterThan(t.start);
    cursor = t.end;
  }
  expect(cursor).toBe(soql.length);
}

describe('tokenizeSoql', () => {
  it('marks clause keywords', () => {
    expect(slices('SELECT Id FROM Account')).toEqual([
      'keyword:SELECT',
      'text:Id',
      'keyword:FROM',
      'text:Account',
    ]);
  });

  it('marks both words of a two-word clause', () => {
    expect(slices('ORDER BY Name')).toEqual(['keyword:ORDER', 'keyword:BY', 'text:Name']);
  });

  it('is case-insensitive', () => {
    expect(slices('select id from Account')).toEqual([
      'keyword:select',
      'text:id',
      'keyword:from',
      'text:Account',
    ]);
  });

  it('marks strings, and does not read keywords inside them', () => {
    expect(slices("WHERE Name = 'FROM SELECT'")).toEqual([
      'keyword:WHERE',
      'text:Name',
      'operator:=',
      "string:'FROM SELECT'",
    ]);
  });

  it('keeps an unterminated string as a string to the end of the input', () => {
    expect(slices("WHERE Name = 'Acme")).toEqual([
      'keyword:WHERE',
      'text:Name',
      'operator:=',
      "string:'Acme",
    ]);
  });

  it('handles an escaped quote inside a literal', () => {
    expect(slices("WHERE Name = 'O\\'Brien' AND Id != null")).toEqual([
      'keyword:WHERE',
      'text:Name',
      'operator:=',
      "string:'O\\'Brien'",
      'keyword:AND',
      'text:Id',
      'operator:!=',
      'number:null',
    ]);
  });

  it('marks numbers and functions', () => {
    expect(slices('SELECT COUNT(Id) FROM Account LIMIT 10')).toEqual([
      'keyword:SELECT',
      'function:COUNT',
      'text:(Id)',
      'keyword:FROM',
      'text:Account',
      'keyword:LIMIT',
      'number:10',
    ]);
  });

  it('does not colour a parenthesised sub-select as one blob', () => {
    expect(slices('SELECT Id, (SELECT Id FROM Contacts) FROM Account')).toEqual([
      'keyword:SELECT',
      'text:Id, (',
      'keyword:SELECT',
      'text:Id',
      'keyword:FROM',
      'text:Contacts)',
      'keyword:FROM',
      'text:Account',
    ]);
  });

  it('marks date literals as values', () => {
    expect(slices('WHERE CreatedDate = LAST_N_DAYS')).toEqual([
      'keyword:WHERE',
      'text:CreatedDate',
      'operator:=',
      'number:LAST_N_DAYS',
    ]);
  });

  it('does not colour a real object name that collides with a clause keyword', () => {
    // Order and Group are standard Salesforce objects, not the ORDER/GROUP clause
    // keywords — only the word right after FROM is exempted, so a genuine ORDER BY
    // later in the same query still highlights normally.
    expect(slices('SELECT Id FROM Order ORDER BY Name')).toEqual([
      'keyword:SELECT',
      'text:Id',
      'keyword:FROM',
      'text:Order',
      'keyword:ORDER',
      'keyword:BY',
      'text:Name',
    ]);
    expect(slices('SELECT Id, (SELECT Id FROM Group) FROM Account')).toEqual([
      'keyword:SELECT',
      'text:Id, (',
      'keyword:SELECT',
      'text:Id',
      'keyword:FROM',
      'text:Group)',
      'keyword:FROM',
      'text:Account',
    ]);
  });

  it('leaves a custom field with a keyword-like prefix alone', () => {
    expect(slices('SELECT Order__c, Group__c FROM Account')).toEqual([
      'keyword:SELECT',
      'text:Order__c, Group__c',
      'keyword:FROM',
      'text:Account',
    ]);
  });

  it('keeps a dotted relationship path as one plain-text run', () => {
    expect(slices('SELECT Account.Owner.Name FROM Contact')).toEqual([
      'keyword:SELECT',
      'text:Account.Owner.Name',
      'keyword:FROM',
      'text:Contact',
    ]);
  });

  it('returns an empty list for empty input', () => {
    expect(tokenizeSoql('')).toEqual([]);
  });

  it('tiles the input with no gaps or overlaps', () => {
    const soql = "SELECT Id, COUNT(Name) FROM Account WHERE Name LIKE 'A%' GROUP BY Id LIMIT 5";
    assertTiles(soql, tokenizeSoql(soql));
  });

  it('tiles multi-line input', () => {
    const soql = 'SELECT Id\n  FROM Account\n  WHERE Id != null';
    assertTiles(soql, tokenizeSoql(soql));
  });

  it('falls back to a single text token past the size cap', () => {
    const soql = 'SELECT Id FROM Account '.padEnd(MAX_HIGHLIGHT_CHARS + 1, 'x');
    expect(tokenizeSoql(soql)).toEqual([{ start: 0, end: soql.length, kind: 'text' }]);
  });
});

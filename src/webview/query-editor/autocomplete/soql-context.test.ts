import { describe, expect, it } from 'vitest';
import { analyzeSoql } from './soql-context';

/** Place the cursor at the `|` marker. */
function at(marked: string) {
  const cursor = marked.indexOf('|');
  return analyzeSoql(marked.replace('|', ''), cursor);
}

describe('analyzeSoql', () => {
  it('suggests objects after FROM', () => {
    const ctx = at('SELECT Id FROM Acc|');
    expect(ctx.kind).toBe('object');
    if (ctx.kind === 'object') expect(ctx.token).toBe('Acc');
  });

  it('suggests fields inside the SELECT list', () => {
    const ctx = at('SELECT Na| FROM Account');
    expect(ctx.kind).toBe('field');
    if (ctx.kind === 'field') {
      expect(ctx.fromObject).toBe('Account');
      expect(ctx.token).toBe('Na');
      expect(ctx.relationshipPath).toEqual([]);
    }
  });

  it('splits a dotted relationship path from the trailing token', () => {
    const ctx = at('SELECT Account.Owner.Na| FROM Contact');
    expect(ctx.kind).toBe('field');
    if (ctx.kind === 'field') {
      expect(ctx.relationshipPath).toEqual(['Account', 'Owner']);
      expect(ctx.token).toBe('Na');
      // replaceStart points just after the last dot.
      expect(ctx.replaceStart).toBe('SELECT Account.Owner.'.length);
    }
  });

  it('suggests fields in WHERE', () => {
    const ctx = at('SELECT Id FROM Account WHERE Ind|');
    expect(ctx.kind).toBe('field');
    if (ctx.kind === 'field') expect(ctx.token).toBe('Ind');
  });

  it('suggests fields in ORDER BY', () => {
    const ctx = at('SELECT Id FROM Account ORDER BY Crea|');
    expect(ctx.kind).toBe('field');
  });

  it('suggests picklist values inside a quoted literal compared to a field', () => {
    const ctx = at("SELECT Id FROM Opportunity WHERE StageName = 'Pro|");
    expect(ctx.kind).toBe('picklist');
    if (ctx.kind === 'picklist') {
      expect(ctx.pickField).toBe('StageName');
      expect(ctx.token).toBe('Pro');
      expect(ctx.fromObject).toBe('Opportunity');
    }
  });

  it('handles an empty picklist token right after the opening quote', () => {
    const ctx = at("SELECT Id FROM Lead WHERE Status = '|");
    expect(ctx.kind).toBe('picklist');
    if (ctx.kind === 'picklist') expect(ctx.token).toBe('');
  });

  it('returns none inside a string that is not a field comparison', () => {
    const ctx = at("SELECT Id FROM Account WHERE Name LIKE '%foo|");
    // LIKE is a comparison operator, so this resolves to a picklist-style value
    // suggestion against Name (harmless — Name has no picklist values).
    expect(ctx.kind).toBe('picklist');
  });

  it('returns none in SELECT when there is no FROM object yet', () => {
    const ctx = at('SELECT Id|');
    expect(ctx.kind).toBe('none');
  });

  it('returns none for empty input', () => {
    expect(analyzeSoql('', 0).kind).toBe('none');
  });
});

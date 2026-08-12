import { describe, expect, it } from 'vitest';
import { capitalizeKeywordEndingAt } from './keyword-case';

/** Apply the capitalization at the `|` marker (a boundary char or end-of-text) if found. */
function apply(marked: string): string {
  const boundaryIndex = marked.indexOf('|');
  const text = marked.replace('|', '');
  const found = capitalizeKeywordEndingAt(text, boundaryIndex);
  if (!found) return text;
  return text.slice(0, found.start) + found.word + text.slice(found.end);
}

describe('capitalizeKeywordEndingAt', () => {
  it('capitalizes a clause keyword when its trailing space is typed', () => {
    expect(apply('select| Id FROM Account')).toBe('SELECT Id FROM Account');
  });

  it('capitalizes each word of a two-word clause independently', () => {
    expect(apply('SELECT Id FROM Account order| BY Name')).toBe(
      'SELECT Id FROM Account ORDER BY Name',
    );
    expect(apply('SELECT Id FROM Account ORDER by| Name')).toBe(
      'SELECT Id FROM Account ORDER BY Name',
    );
  });

  it('capitalizes operator words', () => {
    expect(apply("WHERE Name = 'x' and| Id != null")).toBe("WHERE Name = 'x' AND Id != null");
    expect(apply('WHERE Name like| ')).toBe('WHERE Name LIKE ');
  });

  it('triggers on a comma or parenthesis, not just whitespace', () => {
    expect(apply('SELECT COUNT(Id) FROM Account group|,')).toBe(
      'SELECT COUNT(Id) FROM Account GROUP,',
    );
    expect(apply('SELECT Id FROM Account where|(Name != null)')).toBe(
      'SELECT Id FROM Account WHERE(Name != null)',
    );
  });

  it('is a no-op when the keyword is already uppercase', () => {
    expect(capitalizeKeywordEndingAt('SELECT Id FROM Account ', 6)).toBeNull();
  });

  it('is a no-op for a field or object name', () => {
    expect(capitalizeKeywordEndingAt('SELECT Name FROM Account ', 11)).toBeNull();
    expect(capitalizeKeywordEndingAt('SELECT Id FROM Account ', 22)).toBeNull();
  });

  it('does not capitalize the FROM object-name slot even for a keyword-shaped object', () => {
    // Order and Group are real standard Salesforce objects, not clause keywords here.
    expect(capitalizeKeywordEndingAt("SELECT Id FROM Order WHERE Status = 'x' ", 20)).toBeNull();
    expect(capitalizeKeywordEndingAt('SELECT Id FROM Group ', 20)).toBeNull();
  });

  it('still capitalizes a genuine ORDER BY / GROUP BY later in the same query', () => {
    expect(apply('SELECT Id FROM Order order| BY Name')).toBe('SELECT Id FROM Order ORDER BY Name');
  });

  it('applies the same FROM guard inside a sub-query', () => {
    const text = 'SELECT Id, (SELECT Id FROM Order) FROM Contact';
    // boundary right before the ')' that closes the sub-query, i.e. right after "Order".
    expect(capitalizeKeywordEndingAt(text, text.indexOf(')'))).toBeNull();
  });

  it('does not fire mid-word', () => {
    // "sel" is not yet a complete keyword and there is no trailing boundary char.
    expect(capitalizeKeywordEndingAt('sel', 3)).toBeNull();
  });

  it('catches the trailing keyword at end-of-text (the blur case)', () => {
    expect(apply('SELECT Id FROM Account limit|')).toBe('SELECT Id FROM Account LIMIT');
  });

  it('returns null for an empty word at the boundary', () => {
    expect(capitalizeKeywordEndingAt('SELECT Id  FROM Account', 10)).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(capitalizeKeywordEndingAt('', 0)).toBeNull();
  });
});

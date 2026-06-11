import { describe, expect, it } from 'vitest';
import { toCsv, toJson } from './export-format';

describe('toCsv', () => {
  it('builds a header row and data rows with CRLF endings', () => {
    const csv = toCsv(
      ['Id', 'Name'],
      [
        ['001', 'Acme'],
        ['002', 'Globex'],
      ],
    );
    expect(csv).toBe('Id,Name\r\n001,Acme\r\n002,Globex');
  });

  it('quotes fields containing commas, quotes or newlines and doubles inner quotes', () => {
    const csv = toCsv(
      ['Name', 'Note'],
      [
        ['Smith, John', 'He said "hi"'],
        ['Line1\nLine2', 'plain'],
      ],
    );
    expect(csv).toBe('Name,Note\r\n"Smith, John","He said ""hi"""\r\n"Line1\nLine2",plain');
  });

  it('renders null cells as empty fields', () => {
    expect(toCsv(['A', 'B'], [['x', null]])).toBe('A,B\r\nx,');
  });

  it('handles a header-only export (no rows)', () => {
    expect(toCsv(['A', 'B'], [])).toBe('A,B');
  });
});

describe('toJson', () => {
  it('maps each row to a { col: value } object, pretty-printed', () => {
    const json = toJson(['Id', 'Name'], [['001', 'Acme']]);
    expect(JSON.parse(json)).toEqual([{ Id: '001', Name: 'Acme' }]);
    expect(json).toContain('\n'); // pretty-printed
  });

  it('preserves null values', () => {
    const json = toJson(['Id', 'Name'], [['001', null]]);
    expect(JSON.parse(json)).toEqual([{ Id: '001', Name: null }]);
  });

  it('returns an empty array for no rows', () => {
    expect(JSON.parse(toJson(['A'], []))).toEqual([]);
  });
});

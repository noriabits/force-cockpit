import { describe, expect, it } from 'vitest';
import { COLUMN_COPY_FORMATS, formatColumn, toCsv, toJson } from './export-format';

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

describe('formatColumn', () => {
  const ids = COLUMN_COPY_FORMATS.map((f) => f.id);

  it('serializes each format', () => {
    const values = ['001', '002', '003'];
    expect(formatColumn(values, 'lines')).toBe('001\n002\n003');
    expect(formatColumn(values, 'csv')).toBe('001,002,003');
    expect(formatColumn(values, 'quoted')).toBe("'001', '002', '003'");
    expect(formatColumn(values, 'parens')).toBe("('001', '002', '003')");
  });

  it('dedupes preserving first-seen order in every format', () => {
    const values = ['a', 'b', 'a', 'c', 'b'];
    expect(formatColumn(values, 'lines')).toBe('a\nb\nc');
    expect(formatColumn(values, 'csv')).toBe('a,b,c');
    expect(formatColumn(values, 'quoted')).toBe("'a', 'b', 'c'");
    expect(formatColumn(values, 'parens')).toBe("('a', 'b', 'c')");
  });

  it('skips null and empty values in every format', () => {
    const values = ['a', null, '', 'b'];
    expect(formatColumn(values, 'lines')).toBe('a\nb');
    expect(formatColumn(values, 'csv')).toBe('a,b');
    expect(formatColumn(values, 'quoted')).toBe("'a', 'b'");
    expect(formatColumn(values, 'parens')).toBe("('a', 'b')");
  });

  it('escapes backslash then single-quote in the quoted formats', () => {
    expect(formatColumn(["O'Brien"], 'quoted')).toBe("'O\\'Brien'");
    expect(formatColumn(['a\\b'], 'quoted')).toBe("'a\\\\b'");
    expect(formatColumn(["O'Brien"], 'parens')).toBe("('O\\'Brien')");
  });

  it('leaves values verbatim in the unquoted formats', () => {
    expect(formatColumn(["O'Brien"], 'lines')).toBe("O'Brien");
    expect(formatColumn(['a\\b'], 'csv')).toBe('a\\b');
  });

  it('returns an empty string for no usable values — never a bare ()', () => {
    for (const id of ids) {
      expect(formatColumn([null, ''], id)).toBe('');
    }
  });

  it('implements every id the menu offers', () => {
    for (const id of ids) {
      expect(formatColumn(['a', 'b'], id)).not.toBe('');
    }
    expect(new Set(ids).size).toBe(ids.length);
  });
});

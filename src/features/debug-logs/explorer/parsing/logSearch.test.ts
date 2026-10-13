import { describe, expect, it } from 'vitest';
import { searchBody } from './logSearch';

const BODY = [
  '65.0 APEX_CODE,DEBUG',
  '20:58:54.1 (1)|USER_DEBUG|[3]|DEBUG|before insert',
  '20:58:54.2 (2)|EXCEPTION_THROWN|[4]|System.DmlException: REQUIRED_FIELD_MISSING',
  '20:58:54.3 (3)|FATAL_ERROR|System.DmlException: Required_Field_Missing',
].join('\r\n');

describe('searchBody', () => {
  it('counts matching lines case-insensitively and names the first', () => {
    expect(searchBody(BODY, 'required_field_missing')).toEqual({
      count: 2,
      firstLine: '20:58:54.2 (2)|EXCEPTION_THROWN|[4]|System.DmlException: REQUIRED_FIELD_MISSING',
      firstLineNo: 3,
    });
  });

  it('strips the CRLF so the line carries no trailing \\r', () => {
    expect(searchBody(BODY, 'before insert')?.firstLine.endsWith('\r')).toBe(false);
  });

  it('returns null for no match and for a blank query', () => {
    expect(searchBody(BODY, 'nothing here')).toBeNull();
    expect(searchBody(BODY, '   ')).toBeNull();
  });

  it('caps a long first line', () => {
    const hit = searchBody(`x${'a'.repeat(500)}needle`, 'x');
    expect(hit?.firstLine.length).toBe(201);
    expect(hit?.firstLine.endsWith('…')).toBe(true);
  });
});

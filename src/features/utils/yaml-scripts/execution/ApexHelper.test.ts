import { describe, expect, it } from 'vitest';
import { apexValue } from './ApexHelper';

describe('apexValue', () => {
  it('quotes a plain string', () => {
    expect(apexValue('0011x000000AbCde')).toBe("'0011x000000AbCde'");
  });

  it('escapes single quotes with a backslash', () => {
    expect(apexValue("O'Brien")).toBe("'O\\'Brien'");
  });

  it('escapes backslashes before quotes, so the escape cannot be neutralised', () => {
    expect(apexValue('C:\\path')).toBe("'C:\\\\path'");
    expect(apexValue("back\\'slash")).toBe("'back\\\\\\'slash'");
  });

  it('escapes newlines as \\n', () => {
    expect(apexValue('line1\nline2')).toBe("'line1\\nline2'");
    expect(apexValue('line1\r\nline2')).toBe("'line1\\nline2'");
    expect(apexValue('line1\rline2')).toBe("'line1\\nline2'");
  });

  it('renders null, undefined and empty string as the Apex null keyword', () => {
    expect(apexValue(null)).toBe('null');
    expect(apexValue(undefined)).toBe('null');
    expect(apexValue('')).toBe('null');
  });

  it('renders numbers and booleans unquoted', () => {
    expect(apexValue(42)).toBe('42');
    expect(apexValue(0)).toBe('0');
    expect(apexValue(-1.5)).toBe('-1.5');
    expect(apexValue(true)).toBe('true');
    expect(apexValue(false)).toBe('false');
  });

  it('renders non-finite numbers as null rather than invalid Apex', () => {
    expect(apexValue(NaN)).toBe('null');
    expect(apexValue(Infinity)).toBe('null');
  });

  it('serializes objects and arrays to quoted JSON for JSON.deserializeUntyped', () => {
    expect(apexValue([{ Name: 'Acme' }])).toBe('\'[{"Name":"Acme"}]\'');
  });

  it('escapes quotes inside serialized JSON', () => {
    expect(apexValue([{ Name: "O'Brien" }])).toBe('\'[{"Name":"O\\\'Brien"}]\'');
  });
});

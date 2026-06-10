import { describe, it, expect } from 'vitest';
import { formatValue } from './format-value';

describe('formatValue', () => {
  it('returns the string form of non-numeric input', () => {
    expect(formatValue('abc')).toBe('abc');
    // Number(undefined) is NaN, so it falls through to the String(... ?? '') branch
    expect(formatValue(undefined)).toBe('');
    // Number(null) is 0 (a valid number), matching the original inline behaviour
    expect(formatValue(null)).toBe('0');
  });

  it('formats currency with exactly two decimals', () => {
    expect(formatValue(1000, 'currency')).toBe('1,000.00');
    expect(formatValue(1234.5, 'currency')).toBe('1,234.50');
  });

  it('formats percent with one decimal and a % suffix', () => {
    expect(formatValue(50, 'percent')).toBe('50.0%');
    expect(formatValue(33.333, 'percent')).toBe('33.3%');
  });

  it('adds thousands separators to integers with no format', () => {
    expect(formatValue(1000)).toBe('1,000');
    expect(formatValue(42)).toBe('42');
  });

  it('caps unformatted decimals at two places', () => {
    expect(formatValue(3.14159)).toBe('3.14');
  });

  it('accepts numeric strings', () => {
    expect(formatValue('1000', 'currency')).toBe('1,000.00');
  });
});

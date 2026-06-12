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

  // Expectations are derived from the same toLocaleString options the
  // implementation uses, so these assertions hold under any host locale
  // (e.g. "1,234.50" on en-US vs "1234,50" on es-ES) rather than baking in one.
  const currency = (n: number) =>
    n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const decimal = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });

  it('formats currency with exactly two decimals', () => {
    expect(formatValue(1000, 'currency')).toBe(currency(1000));
    expect(formatValue(1234.5, 'currency')).toBe(currency(1234.5));
  });

  it('formats percent with one decimal and a % suffix', () => {
    expect(formatValue(50, 'percent')).toBe('50.0%');
    expect(formatValue(33.333, 'percent')).toBe('33.3%');
  });

  it('adds thousands separators to integers with no format', () => {
    expect(formatValue(1000)).toBe((1000).toLocaleString());
    expect(formatValue(42)).toBe((42).toLocaleString());
  });

  it('caps unformatted decimals at two places', () => {
    expect(formatValue(3.14159)).toBe(decimal(3.14159));
  });

  it('accepts numeric strings', () => {
    expect(formatValue('1000', 'currency')).toBe(currency(1000));
  });
});

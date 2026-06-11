import { describe, expect, it } from 'vitest';
import { extractMetric } from './metric-value';

describe('extractMetric', () => {
  it('returns empty when there are no datasets', () => {
    expect(extractMetric({}, null)).toEqual({ empty: true });
    expect(extractMetric({ datasets: [] }, null)).toEqual({ empty: true });
  });

  it('returns empty when the first dataset has no data points', () => {
    expect(extractMetric({ datasets: [{ label: 'X', data: [] }] }, null)).toEqual({ empty: true });
  });

  it('returns the locale-formatted value and label for a plain number', () => {
    expect(extractMetric({ datasets: [{ label: 'Total', data: [1234] }] }, null)).toEqual({
      empty: false,
      text: (1234).toLocaleString(),
      label: 'Total',
    });
  });

  it('applies currency formatting from the first value field', () => {
    const result = extractMetric({ datasets: [{ label: 'Amt', data: [1000] }] }, [
      { format: 'currency' },
    ]);
    expect(result).toEqual({
      empty: false,
      text: (1000).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
      label: 'Amt',
    });
  });

  it('applies percent formatting from the first value field', () => {
    const result = extractMetric({ datasets: [{ label: 'Rate', data: [42] }] }, [
      { format: 'percent' },
    ]);
    expect(result).toEqual({ empty: false, text: '42.0%', label: 'Rate' });
  });

  it('falls back to an empty label when the dataset has none', () => {
    const result = extractMetric({ datasets: [{ data: [7] }] }, null);
    expect(result).toEqual({ empty: false, text: (7).toLocaleString(), label: '' });
  });
});

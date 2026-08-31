import { describe, it, expect } from 'vitest';
import { nonNumericDatasets } from './numeric-data';

describe('nonNumericDatasets', () => {
  it('reports a dataset whose values are all NaN', () => {
    // The real case: `chartType: doughnut` over `SELECT Id FROM Contact` with
    // `valueFields: [{ field: Id }]`. The host's Number() coercion turns every
    // record Id into NaN, so there is nothing to draw.
    const ids = ['0031r000025Nb1lAAC', '0031r000025Nb1mAAC'].map(Number);
    expect(nonNumericDatasets([{ label: 'Id', data: ids }])).toEqual(['Id']);
  });

  it('says nothing about a dataset with real numbers', () => {
    expect(nonNumericDatasets([{ label: 'Cnt', data: [3, 7, 1] }])).toEqual([]);
  });

  it('keeps a dataset that is only PARTLY numeric — the numbers still plot', () => {
    expect(nonNumericDatasets([{ label: 'Mixed', data: [NaN, 5] }])).toEqual([]);
  });

  it('treats zero as a real value, not as missing', () => {
    expect(nonNumericDatasets([{ label: 'Zero', data: [0, 0] }])).toEqual([]);
  });

  it('rejects Infinity — Chart.js cannot scale it either', () => {
    expect(nonNumericDatasets([{ label: 'Inf', data: [Infinity] }])).toEqual(['Inf']);
  });

  it('does not coerce: a numeric STRING is not a number', () => {
    // Guards the boundary — datasets arrive over postMessage. `!isNaN('5')`
    // would pass this and then plot nothing.
    expect(nonNumericDatasets([{ label: 'Str', data: ['5'] }])).toEqual(['Str']);
  });

  it('names each offending dataset, and numbers unlabelled ones by their real index', () => {
    const result = nonNumericDatasets([
      { label: 'Good', data: [1] },
      { data: [NaN] },
      { label: 'Bad', data: [NaN] },
    ]);
    // 'Series 2', not 'Series 1' — the fallback counts position in the input,
    // not position among the failures.
    expect(result).toEqual(['Series 2', 'Bad']);
  });

  it('reports nothing for an empty dataset list, so the caller falls through', () => {
    expect(nonNumericDatasets([])).toEqual([]);
    expect(nonNumericDatasets(null)).toEqual([]);
    expect(nonNumericDatasets(undefined)).toEqual([]);
  });
});

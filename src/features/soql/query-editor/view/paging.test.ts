import { describe, expect, it } from 'vitest';
import {
  MAX_LOADED_ROWS,
  canLoadMore,
  describeResultSize,
  mergeBatch,
  reachedRowLimit,
  shouldFetchNext,
  type PagedResult,
} from './paging';

const URL1 = '/services/data/v65.0/query/01g-2000';
const URL2 = '/services/data/v65.0/query/01g-4000';

function rows(n: number, from = 0) {
  return Array.from({ length: n }, (_, i) => ({ Id: String(from + i) }));
}

function partial(loaded: number, totalSize: number): PagedResult {
  return { records: rows(loaded), totalSize, done: false, nextRecordsUrl: URL1 };
}

describe('canLoadMore', () => {
  it('is true only for an unfinished result that carries a locator', () => {
    expect(canLoadMore(partial(2000, 5000))).toBe(true);
    expect(canLoadMore({ records: rows(3), totalSize: 3, done: true })).toBe(false);
    expect(canLoadMore({ records: rows(3), totalSize: 9, done: false })).toBe(false);
    expect(canLoadMore(null)).toBe(false);
  });

  it('leaves a SELECT COUNT() alone', () => {
    expect(canLoadMore({ records: [], totalSize: 42, done: true })).toBe(false);
  });
});

describe('mergeBatch', () => {
  it('appends rows, advances the locator and keeps the echoed request fields', () => {
    const prev = { ...partial(2, 6), soql: 'SELECT Id FROM Account', useToolingApi: false };
    const next = mergeBatch(prev, { records: rows(2, 2), done: false, nextRecordsUrl: URL2 });

    expect(next.records).toEqual(rows(4));
    expect(next.nextRecordsUrl).toBe(URL2);
    expect(next.totalSize).toBe(6);
    expect(next.soql).toBe('SELECT Id FROM Account');
    expect(next.useToolingApi).toBe(false);
  });

  it('drops the locator on the last batch and does not mutate the previous result', () => {
    const prev = partial(2, 4);
    const next = mergeBatch(prev, { records: rows(2, 2), done: true });

    expect(next.done).toBe(true);
    expect('nextRecordsUrl' in next).toBe(false);
    expect(prev.records).toHaveLength(2);
  });

  it('clears an earlier paging error once a batch succeeds', () => {
    const prev = { ...partial(2, 6), pagingError: 'INVALID_QUERY_LOCATOR' };
    const next = mergeBatch(prev, { records: rows(2, 2), done: false, nextRecordsUrl: URL2 });
    expect('pagingError' in next).toBe(false);
  });
});

describe('row limit', () => {
  it('keeps fetching below the limit and stops at it', () => {
    expect(shouldFetchNext(partial(4, 100), 6)).toBe(true);
    expect(shouldFetchNext(partial(6, 100), 6)).toBe(false);
    expect(reachedRowLimit(partial(6, 100), 6)).toBe(true);
  });

  it('stops when the result is complete, limit or not', () => {
    expect(shouldFetchNext({ records: rows(4), totalSize: 4, done: true })).toBe(false);
  });

  it('truncates a batch that would overshoot the limit', () => {
    const next = mergeBatch(
      partial(5, 100),
      {
        records: rows(3, 5),
        done: false,
        nextRecordsUrl: URL2,
      },
      6,
    );
    expect(next.records).toEqual(rows(6));
    expect(shouldFetchNext(next, 6)).toBe(false);
  });

  it('never holds more than 50,000 rows', () => {
    expect(MAX_LOADED_ROWS).toBe(50_000);
    expect(shouldFetchNext(partial(48_000, 90_000))).toBe(true);
    const next = mergeBatch(partial(49_000, 90_000), {
      records: rows(2000, 49_000),
      done: false,
      nextRecordsUrl: URL2,
    });
    expect(next.records).toHaveLength(50_000);
    expect(shouldFetchNext(next)).toBe(false);
  });
});

describe('describeResultSize', () => {
  it('states the total for a complete result', () => {
    expect(describeResultSize({ records: rows(1), totalSize: 1, done: true })).toBe('1 record');
    expect(describeResultSize({ records: rows(3), totalSize: 3, done: true })).toBe('3 records');
  });

  it('says how much of the real totalSize is loaded when partial', () => {
    expect(describeResultSize(partial(2000, 10_000))).toBe('Showing 2,000 of 10,000 records');
  });

  it('says why loading stopped at the row limit', () => {
    expect(describeResultSize(partial(50_000, 120_000))).toBe(
      'Showing 50,000 of 120,000 records — stopped at the 50,000-row limit; narrow the query to see the rest',
    );
  });
});

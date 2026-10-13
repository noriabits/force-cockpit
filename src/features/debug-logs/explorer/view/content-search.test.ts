import { describe, expect, it } from 'vitest';
import {
  applyBatch,
  failSearch,
  nextBatch,
  SEARCH_BATCH_SIZE,
  startSearch,
  unsearchedCount,
} from './content-search';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `07L${i}`);
const hit = (id: string) => ({ id, count: 1, firstLine: 'x', firstLineNo: 1 });

describe('content search state', () => {
  it('walks the listed ids in batches until every one is scanned', () => {
    const search = startSearch('  boom  ', ids(SEARCH_BATCH_SIZE + 5));
    expect(search.query).toBe('boom');

    const first = nextBatch(search);
    expect(first).toHaveLength(SEARCH_BATCH_SIZE);
    applyBatch(search, first.length, [hit(first[3])]);
    expect(search.done).toBe(false);

    const second = nextBatch(search);
    expect(second).toHaveLength(5);
    applyBatch(search, second.length, []);
    expect(search.done).toBe(true);
    expect(search.scanned).toBe(SEARCH_BATCH_SIZE + 5);
    expect([...search.matches.keys()]).toEqual([first[3]]);
    expect(nextBatch(search)).toEqual([]);
  });

  it('is done at once with nothing listed', () => {
    const search = startSearch('boom', []);
    expect(search.done).toBe(true);
    expect(nextBatch(search)).toEqual([]);
  });

  it('stops on a failed batch', () => {
    const search = startSearch('boom', ids(50));
    nextBatch(search);
    failSearch(search, 'INVALID_SESSION_ID');
    expect(search.done).toBe(true);
    expect(search.error).toBe('INVALID_SESSION_ID');
    expect(nextBatch(search)).toEqual([]);
  });

  it('counts logs listed after the search started', () => {
    const search = startSearch('boom', ['a', 'b']);
    expect(unsearchedCount(search, ['c', 'a', 'b'])).toBe(1);
  });
});

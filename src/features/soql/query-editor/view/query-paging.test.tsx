// @vitest-environment jsdom
//
// Drives createQueryPaging through its real seams — the posts it makes and the
// replies index.js hands it — with a minimal stand-in for the tab strip's
// per-tab run tracking.
import { describe, expect, it, vi } from 'vitest';
import { createQueryPaging } from './query-paging';

const URL1 = '/services/data/v65.0/query/01g-2000';
const URL2 = '/services/data/v65.0/query/01g-4000';

type Tab = { opId: string | null; results: Record<string, unknown> | null };

function rows(n: number, from = 0) {
  return Array.from({ length: n }, (_, i) => ({ Id: String(from + i) }));
}

function setup(results: Record<string, unknown> | null) {
  const tab: Tab = { opId: null, results };
  const tabs = {
    setActiveOpId: (opId: string | null, t: Tab = tab) => {
      t.opId = opId;
    },
    settleRun: (t: Tab, r: Record<string, unknown>) => {
      t.opId = null;
      t.results = r;
    },
  };
  const vscode = { postMessage: vi.fn() };
  const onProgress = vi.fn();
  const onSettled = vi.fn();
  let seq = 0;
  const paging = createQueryPaging({
    vscode,
    tabs,
    nextOpId: () => `soql-${++seq}`,
    onProgress,
    onSettled,
  });
  const queryMorePosts = () =>
    vscode.postMessage.mock.calls.map((c) => c[0]).filter((m) => m.type === 'queryMore');
  /** Answer the batch the tab is waiting on, as index.js's ownerOf would. */
  const reply = (data: Record<string, unknown>) =>
    paging.onResult({ tab, opId: tab.opId as string }, data);
  return { tab, paging, vscode, onProgress, onSettled, queryMorePosts, reply };
}

const partial = (extra: Record<string, unknown> = {}) => ({
  records: rows(2),
  totalSize: 6,
  done: false,
  nextRecordsUrl: URL1,
  soql: 'SELECT Id FROM ApexClass',
  useToolingApi: true,
  ...extra,
});

describe('query paging', () => {
  it('asks for nothing when the first batch is the whole result', () => {
    const s = setup({ records: rows(3), totalSize: 3, done: true });
    expect(s.paging.continueLoading(s.tab)).toBe(false);
    expect(s.vscode.postMessage).not.toHaveBeenCalled();
  });

  it('leaves a SELECT COUNT() alone', () => {
    const s = setup({ records: [], totalSize: 42, done: true });
    expect(s.paging.continueLoading(s.tab)).toBe(false);
  });

  it('sends the locator and the API the first batch ran on — never the rows', () => {
    const s = setup(partial());
    expect(s.paging.continueLoading(s.tab)).toBe(true);

    expect(s.queryMorePosts()).toEqual([
      { type: 'queryMore', locator: URL1, useToolingApi: true, opId: 'soql-1' },
    ]);
    expect(s.vscode.postMessage).toHaveBeenCalledWith({
      type: 'operationStarted',
      opId: 'soql-1',
    });
    expect(s.tab.opId).toBe('soql-1');
    expect(s.paging.isPaging('soql-1')).toBe(true);
  });

  it('does not start a second load while a batch is in flight', () => {
    const s = setup(partial());
    s.paging.continueLoading(s.tab);
    expect(s.paging.continueLoading(s.tab)).toBe(false);
    expect(s.queryMorePosts()).toHaveLength(1);
  });

  it('keeps asking after each batch until the result is complete', () => {
    const s = setup(partial());
    s.paging.continueLoading(s.tab);
    s.reply({ records: rows(2, 2), totalSize: 6, done: false, nextRecordsUrl: URL2 });
    expect(s.onProgress).toHaveBeenCalledTimes(1);
    expect(s.onSettled).not.toHaveBeenCalled();
    expect(s.queryMorePosts().map((m) => m.locator)).toEqual([URL1, URL2]);

    s.reply({ records: rows(2, 4), totalSize: 6, done: true });
    expect(s.queryMorePosts()).toHaveLength(2);
    expect(s.tab.results?.records).toEqual(rows(6));
    expect(s.tab.results?.soql).toBe('SELECT Id FROM ApexClass');
    expect(s.tab.opId).toBeNull();
    expect(s.onSettled).toHaveBeenCalledTimes(1);
  });

  it('stops at 50,000 rows and never holds more', () => {
    const s = setup(partial({ records: rows(49_000), totalSize: 90_000 }));
    s.paging.continueLoading(s.tab);
    s.reply({ records: rows(2000, 49_000), totalSize: 90_000, done: false, nextRecordsUrl: URL2 });

    expect(s.queryMorePosts()).toHaveLength(1);
    expect(s.tab.results?.records).toHaveLength(50_000);
    expect(s.onSettled).toHaveBeenCalledWith(s.tab);
  });

  it('a stopped load asks for nothing more', () => {
    const s = setup(partial());
    s.paging.continueLoading(s.tab);
    const opId = s.tab.opId;
    // index.js's stop path: forget the batch and clear the tab, so its reply
    // finds no owner and is dropped before it ever reaches onResult.
    s.paging.forget(opId);
    s.tab.opId = null;

    expect(s.paging.isPaging(opId)).toBe(false);
    expect(s.queryMorePosts()).toHaveLength(1);
    expect(s.tab.results?.records).toEqual(rows(2));
  });

  it('a failed batch keeps the loaded rows and records why', () => {
    const s = setup(partial());
    s.paging.continueLoading(s.tab);
    s.paging.onError(
      { tab: s.tab, opId: s.tab.opId as string },
      { message: 'INVALID_QUERY_LOCATOR' },
    );

    expect(s.tab.results?.records).toEqual(rows(2));
    expect(s.tab.results?.pagingError).toBe('INVALID_QUERY_LOCATOR');
    expect(s.tab.opId).toBeNull();
    expect(s.queryMorePosts()).toHaveLength(1);
    expect(s.onSettled).toHaveBeenCalledWith(s.tab);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { ApexLogApi } from './ApexLogApi';
import type { ToolingRest } from './ToolingRest';

function makeRest(removeMultipleImpl?: (ids: string[]) => Promise<unknown>) {
  return {
    query: vi.fn(async () => []),
    queryData: vi.fn(async () => []),
    create: vi.fn(async () => 'newId'),
    update: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    removeMultiple: vi.fn(
      removeMultipleImpl ??
        (async (ids: string[]) => ids.map((id) => ({ id, success: true, errors: [] }))),
    ),
    getText: vi.fn(async () => ''),
  };
}

function api(rest: ReturnType<typeof makeRest>) {
  return new ApexLogApi(rest as unknown as ToolingRest);
}

describe('deleteLogs', () => {
  it('deletes a small batch in a single Collections call, never the Tooling API single-delete endpoint', async () => {
    const rest = makeRest();
    const result = await api(rest).deleteLogs(['1', '2', '3']);

    expect(rest.removeMultiple).toHaveBeenCalledTimes(1);
    expect(rest.removeMultiple).toHaveBeenCalledWith(['1', '2', '3']);
    expect(rest.remove).not.toHaveBeenCalled();
    expect(result).toEqual({ deleted: 3, failed: 0 });
  });

  it('chunks a list over 200 ids into parallel Collections calls of at most 200', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `id${i}`);
    const rest = makeRest();
    const result = await api(rest).deleteLogs(ids);

    expect(rest.removeMultiple).toHaveBeenCalledTimes(3);
    const sizes = rest.removeMultiple.mock.calls.map((call) => (call[0] as string[]).length);
    expect(sizes).toEqual([200, 200, 50]);
    expect(result).toEqual({ deleted: 450, failed: 0 });
  });

  it('counts per-id failures from a Collections reply without throwing', async () => {
    const rest = makeRest(async (ids) =>
      ids.map((id, i) => ({ id, success: i % 2 === 0, errors: i % 2 === 0 ? [] : ['nope'] })),
    );
    const result = await api(rest).deleteLogs(['a', 'b', 'c', 'd']);

    expect(result).toEqual({ deleted: 2, failed: 2 });
  });

  it('treats a whole-chunk failure (thrown error) as every id in that chunk failing', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `id${i}`);
    const rest = makeRest();
    rest.removeMultiple = vi.fn(async (chunkIds: string[]) => {
      if (chunkIds.length === 200) throw new Error('boom');
      return chunkIds.map((id) => ({ id, success: true, errors: [] }));
    });

    const result = await api(rest).deleteLogs(ids);

    expect(result).toEqual({ deleted: 50, failed: 200 });
  });

  it('returns zero/zero for an empty list without calling the API', async () => {
    const rest = makeRest();
    const result = await api(rest).deleteLogs([]);

    expect(rest.removeMultiple).not.toHaveBeenCalled();
    expect(result).toEqual({ deleted: 0, failed: 0 });
  });
});

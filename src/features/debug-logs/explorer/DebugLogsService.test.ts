import { describe, expect, it, vi } from 'vitest';
import type { ConnectionManager } from '../../../salesforce/connection';
import { DebugLogsService } from './DebugLogsService';

function makeService(bodies: Record<string, string>) {
  const service = new DebugLogsService({} as unknown as ConnectionManager);
  const getBody = vi.fn(async (id: string) => {
    if (!(id in bodies)) throw new Error('NOT_FOUND');
    return bodies[id];
  });
  (service as any).logs = { getBody };
  return { service, getBody };
}

describe('DebugLogsService.searchLogBodies', () => {
  it('returns only the logs whose body contains the text', async () => {
    const { service } = makeService({ a: 'one\nBOOM here', b: 'quiet', c: 'boom' });
    const matches = await service.searchLogBodies(['a', 'b', 'c'], 'boom');
    expect(matches).toEqual([
      { id: 'a', count: 1, firstLine: 'BOOM here', firstLineNo: 2 },
      { id: 'c', count: 1, firstLine: 'boom', firstLineNo: 1 },
    ]);
  });

  it('treats an unreadable body as no match rather than failing the batch', async () => {
    const { service } = makeService({ a: 'boom' });
    expect(await service.searchLogBodies(['gone', 'a'], 'boom')).toHaveLength(1);
  });

  it('does not fill the body cache, so the viewer keeps its bodies', async () => {
    const { service, getBody } = makeService({ a: 'boom' });
    await service.searchLogBodies(['a'], 'boom');
    await service.getBody('a');
    expect(getBody).toHaveBeenCalledTimes(2);
  });

  it('reads a body the viewer already cached without fetching it again', async () => {
    const { service, getBody } = makeService({ a: 'boom' });
    await service.getBody('a');
    await service.searchLogBodies(['a'], 'boom');
    expect(getBody).toHaveBeenCalledTimes(1);
  });

  it('stops with the shared sentinel once aborted', async () => {
    const { service } = makeService({ a: 'boom' });
    const ac = new AbortController();
    ac.abort();
    await expect(service.searchLogBodies(['a'], 'boom', ac.signal)).rejects.toThrow(
      'Operation cancelled',
    );
  });
});

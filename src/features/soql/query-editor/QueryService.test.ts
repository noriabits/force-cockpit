import { describe, expect, it, vi } from 'vitest';
import { QueryService } from './QueryService';
import type { ConnectionManager } from '../../../salesforce/connection';

function makeMock(overrides: Partial<ConnectionManager> = {}): ConnectionManager {
  return {
    query: vi.fn().mockResolvedValue({ records: [{ Id: '1' }], totalSize: 1, done: true }),
    toolingQuery: vi.fn().mockResolvedValue({ records: [{ Id: 't' }], totalSize: 1, done: true }),
    ...overrides,
  } as unknown as ConnectionManager;
}

describe('QueryService.runQuery', () => {
  it('uses the regular query() by default', async () => {
    const cm = makeMock();
    const svc = new QueryService(cm);
    const res = await svc.runQuery('SELECT Id FROM Account');
    expect(cm.query).toHaveBeenCalledWith('SELECT Id FROM Account');
    expect(cm.toolingQuery).not.toHaveBeenCalled();
    expect(res).toEqual({ records: [{ Id: '1' }], totalSize: 1, done: true });
  });

  it('uses toolingQuery() when useToolingApi is true', async () => {
    const cm = makeMock();
    const svc = new QueryService(cm);
    const res = await svc.runQuery('SELECT Id FROM ApexClass', true);
    expect(cm.toolingQuery).toHaveBeenCalledWith('SELECT Id FROM ApexClass');
    expect(cm.query).not.toHaveBeenCalled();
    expect(res.records).toEqual([{ Id: 't' }]);
  });

  it('never reaches the org when the signal is already aborted', async () => {
    const cm = makeMock();
    const svc = new QueryService(cm);
    const ac = new AbortController();
    ac.abort();

    await expect(svc.runQuery('SELECT Id FROM Account', false, ac.signal)).rejects.toThrow(
      'Operation cancelled',
    );
    expect(cm.query).not.toHaveBeenCalled();
  });

  it('rejects as soon as the signal aborts, leaving the request to settle unheard', async () => {
    let settle: (v: unknown) => void = () => {};
    const inFlight = new Promise((resolve) => {
      settle = resolve;
    });
    const cm = makeMock({ query: vi.fn().mockReturnValue(inFlight) } as Partial<ConnectionManager>);
    const svc = new QueryService(cm);
    const ac = new AbortController();

    const run = svc.runQuery('SELECT Id FROM Account', false, ac.signal);
    ac.abort();
    await expect(run).rejects.toThrow('Operation cancelled');

    // The abandoned request resolving afterwards must not surface anywhere.
    settle({ records: [{ Id: 'late' }], totalSize: 1, done: true });
    await expect(inFlight).resolves.toBeDefined();
  });

  it('behaves exactly as before when no signal is passed', async () => {
    const cm = makeMock();
    const svc = new QueryService(cm);
    const res = await svc.runQuery('SELECT Id FROM Account', false, undefined);
    expect(res).toEqual({ records: [{ Id: '1' }], totalSize: 1, done: true });
  });
});

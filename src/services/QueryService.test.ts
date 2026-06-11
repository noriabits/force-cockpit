import { describe, expect, it, vi } from 'vitest';
import { QueryService } from './QueryService';
import type { ConnectionManager } from '../salesforce/connection';

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
});

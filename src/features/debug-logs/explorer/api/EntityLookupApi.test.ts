import { describe, expect, it, vi } from 'vitest';
import { EntityLookupApi } from './EntityLookupApi';
import type { ToolingRest } from './ToolingRest';
import type { ConnectionManager } from '../../../../salesforce/connection';

function makeRest(results: unknown[][] = []) {
  const queue = [...results];
  const next = async () => queue.shift() ?? [];
  return { query: vi.fn(next), queryData: vi.fn(next) };
}

function makeCm(username = 'pablo@example.com'): ConnectionManager {
  return { getCurrentOrg: () => ({ username }) } as unknown as ConnectionManager;
}

function api(rest: ReturnType<typeof makeRest>, cm = makeCm()) {
  return new EntityLookupApi(rest as unknown as ToolingRest, cm);
}

describe('User lookups', () => {
  // The Tooling API exposes a cut-down User object without UserType/IsActive:
  // querying it there fails with "No such column 'UserType' on entity 'User'".
  it('reads the current user through the standard Data API', async () => {
    const rest = makeRest([[{ Id: '005a', Name: 'Pablo', Username: 'pablo@example.com' }]]);
    const entity = await api(rest).currentUser();
    expect(entity).toEqual({
      id: '005a',
      name: 'Pablo',
      subtitle: 'pablo@example.com',
      kind: 'user',
    });
    expect(rest.queryData).toHaveBeenCalledTimes(1);
    expect(rest.query).not.toHaveBeenCalled();
  });

  it('returns null when there is no connected org or no matching user', async () => {
    expect(await api(makeRest([[]])).currentUser()).toBeNull();
    const noOrg = { getCurrentOrg: () => null } as unknown as ConnectionManager;
    expect(await api(makeRest(), noOrg).currentUser()).toBeNull();
  });

  it('finds the system users by UserType through the standard Data API', async () => {
    const rest = makeRest([
      [
        {
          Id: '005auto',
          Name: 'Automated Process',
          Username: 'autoproc@00d.com',
          UserType: 'AutomatedProcess',
        },
      ],
    ]);
    const users = await api(rest).systemUsers();
    expect(users[0]).toMatchObject({ name: 'Automated Process', system: true, kind: 'user' });
    expect(users[0].subtitle).toContain('AutomatedProcess');
    const soql = rest.queryData.mock.calls[0][0] as string;
    expect(soql).toContain("UserType IN ('AutomatedProcess', 'PlatformIntegration')");
    expect(rest.query).not.toHaveBeenCalled();
  });

  it('marks inactive users in the search results', async () => {
    const rest = makeRest([
      [{ Id: '005b', Name: 'Old User', Username: 'old@example.com', IsActive: false }],
    ]);
    const results = await api(rest).searchUsers('old');
    expect(results[0].subtitle).toBe('old@example.com (inactive)');
  });

  it('escapes quotes in the search term', async () => {
    const rest = makeRest([[]]);
    await api(rest).searchUsers("O'Brien");
    expect(rest.queryData.mock.calls[0][0]).toContain("O\\'Brien");
  });

  it('skips the round-trip for a blank search term', async () => {
    const rest = makeRest();
    expect(await api(rest).searchUsers('   ')).toEqual([]);
    expect(rest.queryData).not.toHaveBeenCalled();
  });
});

describe('searchApexEntities', () => {
  it('combines classes and triggers from the Tooling API', async () => {
    const rest = makeRest([
      [{ Id: '01p1', Name: 'OrderService', NamespacePrefix: null }],
      [{ Id: '01q1', Name: 'OrderTrigger', TableEnumOrId: 'Order' }],
    ]);
    const results = await api(rest).searchApexEntities('order');
    expect(results.map((r) => r.kind)).toEqual(['apexClass', 'apexTrigger']);
    expect(results[1].subtitle).toBe('Trigger on Order');
    // Apex metadata genuinely lives in the Tooling API.
    expect(rest.query).toHaveBeenCalledTimes(2);
    expect(rest.queryData).not.toHaveBeenCalled();
  });
});

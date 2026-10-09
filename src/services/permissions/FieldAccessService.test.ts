import { describe, expect, it, vi } from 'vitest';
import { FieldAccessService } from './FieldAccessService';
import type { ConnectionManager } from '../../salesforce/connection';

function makeMock(overrides: Record<string, unknown> = {}): ConnectionManager {
  return {
    getCurrentOrg: () => ({ orgId: '00Dxx' }),
    toolingQuery: vi.fn().mockResolvedValue({ records: [] }),
    query: vi.fn().mockResolvedValue({ records: [] }),
    ...overrides,
  } as unknown as ConnectionManager;
}

function grant(field: string, name: string, groupLabel?: string) {
  return {
    Field: field,
    Parent: {
      Name: name,
      PermissionSetGroupId: groupLabel ? '0PG000000000001' : null,
      PermissionSetGroup: groupLabel ? { MasterLabel: groupLabel } : null,
    },
  };
}

describe('FieldAccessService.grants', () => {
  it('asks once for the whole batch, for the requested access level, profiles excluded', async () => {
    const query = vi.fn().mockResolvedValue({ records: [] });
    const svc = new FieldAccessService(makeMock({ query }));

    await svc.grants('Account', ['Rating', 'Region__c'], 'edit');

    expect(query).toHaveBeenCalledTimes(1);
    const soql = query.mock.calls[0][0] as string;
    expect(soql).toContain("SObjectType = 'Account'");
    expect(soql).toContain("Field IN ('Account.Rating', 'Account.Region__c')");
    expect(soql).toContain('PermissionsEdit = true');
    expect(soql).toContain('Parent.IsOwnedByProfile = false');
  });

  it('groups by field (lowercased), naming groups by label and de-duplicating', async () => {
    const svc = new FieldAccessService(
      makeMock({
        query: vi.fn().mockResolvedValue({
          records: [
            grant('Account.Rating', 'Sales_Ops'),
            grant('Account.Rating', 'Sales_Ops'),
            grant('Account.Rating', 'X0001', 'Field Access'),
            grant('Account.Region__c', 'Regional'),
          ],
        }),
      }),
    );

    const byField = await svc.grants('Account', ['Rating', 'Region__c'], 'read');

    expect(byField?.get('rating')).toEqual([
      'Sales_Ops (Permission Set)',
      'Field Access (Permission Set Group)',
    ]);
    expect(byField?.get('region__c')).toEqual(['Regional (Permission Set)']);
  });

  it('caps the names listed per field', async () => {
    const records = Array.from({ length: 20 }, (_, i) => grant('Account.Rating', `PS_${i}`));
    const svc = new FieldAccessService(makeMock({ query: vi.fn().mockResolvedValue({ records }) }));

    expect((await svc.grants('Account', ['Rating'], 'read'))?.get('rating')).toHaveLength(15);
  });

  it('resolves null when FieldPermissions is not queryable', async () => {
    const svc = new FieldAccessService(
      makeMock({ query: vi.fn().mockRejectedValue(new Error('INSUFFICIENT_ACCESS')) }),
    );
    expect(await svc.grants('Account', ['Rating'], 'read')).toBeNull();
  });

  it('never interpolates an unsafe name into the query', async () => {
    const query = vi.fn().mockResolvedValue({ records: [] });
    const svc = new FieldAccessService(makeMock({ query }));

    expect(await svc.grants("Account' OR ''='", ['Rating'], 'read')).toBeNull();
    expect(await svc.grants('Account', ["Rating') OR (Field = 'x"], 'read')).toEqual(new Map());
    expect(query).not.toHaveBeenCalled();
  });
});

describe('FieldAccessService.fieldDefinitions', () => {
  it('caches per org + entity', async () => {
    const toolingQuery = vi.fn().mockResolvedValue({
      records: [{ QualifiedApiName: 'Name', Label: 'Name', DataType: 'Text' }],
    });
    const svc = new FieldAccessService(makeMock({ toolingQuery }));

    await svc.fieldDefinitions('Account');
    await svc.fieldDefinitions('account');

    expect(toolingQuery).toHaveBeenCalledTimes(1);
  });

  it('resolves null when the Tooling query fails or finds nothing', async () => {
    const failing = new FieldAccessService(
      makeMock({ toolingQuery: vi.fn().mockRejectedValue(new Error('no setup')) }),
    );
    expect(await failing.fieldDefinitions('Account')).toBeNull();
    expect(await new FieldAccessService(makeMock()).fieldDefinitions('Account')).toBeNull();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { DescribeService } from './DescribeService';
import type { ConnectionManager } from '../salesforce/connection';

function makeMock(overrides: Partial<ConnectionManager> = {}): ConnectionManager {
  return {
    getCurrentOrg: vi.fn(() => ({ orgId: 'ORG1' })),
    describeGlobal: vi.fn().mockResolvedValue({
      sobjects: [
        { name: 'Account', label: 'Account', keyPrefix: '001' },
        { name: 'Contact', label: 'Contact', keyPrefix: '003' },
      ],
    }),
    describeSObject: vi.fn().mockResolvedValue({
      name: 'Account',
      fields: [
        { name: 'Id', label: 'Id', type: 'id', relationshipName: null, referenceTo: [] },
        {
          name: 'OwnerId',
          label: 'Owner ID',
          type: 'reference',
          relationshipName: 'Owner',
          referenceTo: ['User'],
        },
        {
          name: 'Industry',
          label: 'Industry',
          type: 'picklist',
          relationshipName: null,
          referenceTo: [],
          picklistValues: [
            { value: 'Tech', active: true },
            { value: 'Retired', active: false },
          ],
        },
      ],
    }),
    ...overrides,
  } as unknown as ConnectionManager;
}

describe('DescribeService', () => {
  it('projects describeGlobal to name/label/keyPrefix', async () => {
    const svc = new DescribeService(makeMock());
    const result = await svc.describeGlobal();
    expect(result.sobjects).toEqual([
      { name: 'Account', label: 'Account', keyPrefix: '001' },
      { name: 'Contact', label: 'Contact', keyPrefix: '003' },
    ]);
  });

  it('caches describeGlobal per org (only one API call)', async () => {
    const cm = makeMock();
    const svc = new DescribeService(cm);
    await svc.describeGlobal();
    await svc.describeGlobal();
    expect(cm.describeGlobal).toHaveBeenCalledTimes(1);
  });

  it('projects fields and drops inactive picklist values', async () => {
    const svc = new DescribeService(makeMock());
    const result = await svc.describeSObject('Account');
    const industry = result.fields.find((f) => f.name === 'Industry');
    expect(industry?.picklistValues).toEqual(['Tech']);
    const owner = result.fields.find((f) => f.name === 'OwnerId');
    expect(owner?.relationshipName).toBe('Owner');
    expect(owner?.referenceTo).toEqual(['User']);
  });

  it('caches describeSObject per org + name', async () => {
    const cm = makeMock();
    const svc = new DescribeService(cm);
    await svc.describeSObject('Account');
    await svc.describeSObject('account');
    expect(cm.describeSObject).toHaveBeenCalledTimes(1);
  });

  it('re-describes after the org changes', async () => {
    let org = 'ORG1';
    const cm = makeMock({ getCurrentOrg: vi.fn(() => ({ orgId: org })) as never });
    const svc = new DescribeService(cm);
    await svc.describeGlobal();
    org = 'ORG2';
    await svc.describeGlobal();
    expect(cm.describeGlobal).toHaveBeenCalledTimes(2);
  });
});

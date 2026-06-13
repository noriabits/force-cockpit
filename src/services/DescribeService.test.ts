import { describe, expect, it, vi } from 'vitest';
import { DescribeService } from './DescribeService';
import type { DescribeDiskCache } from './DescribeDiskCache';
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

  function makeDiskCache(overrides: Partial<DescribeDiskCache> = {}): DescribeDiskCache {
    return {
      readGlobal: vi.fn(() => null),
      writeGlobal: vi.fn(),
      readSObject: vi.fn(() => null),
      writeSObject: vi.fn(),
      clear: vi.fn(),
      ...overrides,
    } as unknown as DescribeDiskCache;
  }

  it('serves a disk-cache hit without calling the server (sObject)', async () => {
    const cm = makeMock();
    const cached = { name: 'Account', fields: [] };
    const disk = makeDiskCache({ readSObject: vi.fn(() => cached) as never });
    const svc = new DescribeService(cm, disk);
    const result = await svc.describeSObject('Account');
    expect(result).toBe(cached);
    expect(cm.describeSObject).not.toHaveBeenCalled();
    expect(disk.readSObject).toHaveBeenCalledWith('ORG1', 'Account');
  });

  it('writes through to the disk cache on a server fetch (sObject)', async () => {
    const cm = makeMock();
    const disk = makeDiskCache();
    const svc = new DescribeService(cm, disk);
    await svc.describeSObject('Account');
    expect(cm.describeSObject).toHaveBeenCalledTimes(1);
    expect(disk.writeSObject).toHaveBeenCalledWith(
      'ORG1',
      'Account',
      expect.objectContaining({ name: 'Account' }),
    );
  });

  it('serves a disk-cache hit without calling the server (global)', async () => {
    const cm = makeMock();
    const cached = { sobjects: [] };
    const disk = makeDiskCache({ readGlobal: vi.fn(() => cached) as never });
    const svc = new DescribeService(cm, disk);
    const result = await svc.describeGlobal();
    expect(result).toBe(cached);
    expect(cm.describeGlobal).not.toHaveBeenCalled();
  });

  it('clearCache clears memory and the disk cache', async () => {
    const cm = makeMock();
    const disk = makeDiskCache();
    const svc = new DescribeService(cm, disk);
    await svc.describeSObject('Account'); // populate memory
    svc.clearCache();
    expect(disk.clear).toHaveBeenCalled();
    await svc.describeSObject('Account'); // memory cleared → server hit again
    expect(cm.describeSObject).toHaveBeenCalledTimes(2);
  });
});

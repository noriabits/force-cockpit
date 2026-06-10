import { describe, expect, it, vi } from 'vitest';
import type { ConnectionManager } from '../salesforce/connection';
import { resolveOrgType } from './orgType';

function makeMock(overrides: Partial<ConnectionManager> = {}): ConnectionManager {
  return {
    isProductionOrg: vi.fn().mockResolvedValue(false),
    getSandboxName: vi.fn().mockReturnValue(null),
    ...overrides,
  } as unknown as ConnectionManager;
}

describe('resolveOrgType', () => {
  it('returns production for a production org', async () => {
    const cm = makeMock({ isProductionOrg: vi.fn().mockResolvedValue(true) });
    expect(await resolveOrgType(cm, ['uat'])).toBe('production');
  });

  it('returns protected-sandbox when sandbox name is in the protected list (case-insensitive)', async () => {
    const cm = makeMock({
      isProductionOrg: vi.fn().mockResolvedValue(false),
      getSandboxName: vi.fn().mockReturnValue('UAT'),
    });
    expect(await resolveOrgType(cm, ['uat', 'staging'])).toBe('protected-sandbox');
  });

  it('returns sandbox for a non-protected sandbox', async () => {
    const cm = makeMock({
      isProductionOrg: vi.fn().mockResolvedValue(false),
      getSandboxName: vi.fn().mockReturnValue('dev1'),
    });
    expect(await resolveOrgType(cm, ['uat'])).toBe('sandbox');
  });

  it('treats a null sandbox name as a plain sandbox', async () => {
    const cm = makeMock({
      isProductionOrg: vi.fn().mockResolvedValue(false),
      getSandboxName: vi.fn().mockReturnValue(null),
    });
    expect(await resolveOrgType(cm, ['uat'])).toBe('sandbox');
  });
});

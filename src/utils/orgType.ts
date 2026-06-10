import { ConnectionManager } from '../salesforce/connection';

export type OrgType = 'production' | 'protected-sandbox' | 'sandbox';

/**
 * Classifies the currently-connected org as production, a protected sandbox, or a
 * plain sandbox. Protected-sandbox matching is case-insensitive against the
 * configured `protectedSandboxes` list.
 */
export async function resolveOrgType(
  connectionManager: ConnectionManager,
  protectedSandboxes: string[],
): Promise<OrgType> {
  if (await connectionManager.isProductionOrg()) return 'production';
  const sandboxName = (connectionManager.getSandboxName() ?? '').toLowerCase();
  const isProtected = protectedSandboxes.map((s) => s.toLowerCase()).includes(sandboxName);
  return isProtected ? 'protected-sandbox' : 'sandbox';
}

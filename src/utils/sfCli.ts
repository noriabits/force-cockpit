import { execFile } from 'child_process';
import { promisify } from 'util';
import { StateAggregator } from '@salesforce/core';

const execFileAsync = promisify(execFile);

export interface SfOrg {
  alias?: string;
  username: string;
  orgId: string;
  instanceUrl: string;
  connectedStatus?: string;
  isDefaultUsername?: boolean;
  isDefaultDevHubUsername?: boolean;
  isScratch?: boolean;
  isSandbox?: boolean;
  expirationDate?: string;
}

// OrgDetails IS an SfOrg plus connection credentials
export interface OrgDetails extends SfOrg {
  accessToken: string;
  clientId?: string;
  loginUrl?: string;
}

/**
 * Triggers the SF CLI to refresh the OAuth2 access token for the given org.
 * Runs `sf org display` which causes the CLI to use the stored refresh token
 * to obtain a new access token and write it back to disk.
 * Best-effort — all errors are silently ignored.
 */
export async function refreshOrgToken(aliasOrUsername: string): Promise<void> {
  try {
    await execFileAsync('sf', ['org', 'display', '--target-org', aliasOrUsername, '--json'], {
      timeout: 15000,
    });
  } catch {
    // Best-effort — ignore errors; the subsequent connect attempt will surface the real issue
  }
}

export async function getOrgDetails(aliasOrUsername: string): Promise<OrgDetails> {
  // Always clear the singleton cache so we read fresh auth data from disk.
  // Without this, switching orgs via the SF extension would leave a stale
  // in-memory StateAggregator that doesn't see the new org's credentials.
  StateAggregator.clearInstance();
  const sa = await StateAggregator.getInstance();
  // resolveUsername: returns username as-is if not an alias, or resolves to the mapped username
  const username = sa.aliases.resolveUsername(aliasOrUsername);
  // decrypt=true to get the access token; throwOnNotFound defaults to true
  const auth = await sa.orgs.read(username, true);
  if (!auth?.accessToken || !auth?.instanceUrl) {
    throw new Error(`No valid credentials found for: ${aliasOrUsername}`);
  }
  const aliases = sa.aliases.getAll(username);
  return {
    // SfOrg fields
    alias: aliases[0],
    username,
    orgId: auth.orgId ?? '',
    instanceUrl: auth.instanceUrl,
    isSandbox: auth.isSandbox ?? false,
    isScratch: auth.isScratch ?? !!auth.devHubUsername,
    expirationDate: auth.expirationDate,
    // OrgDetails fields
    accessToken: auth.accessToken,
    clientId: auth.clientId,
    loginUrl: auth.loginUrl,
  };
}

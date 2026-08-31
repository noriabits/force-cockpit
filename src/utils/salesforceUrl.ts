import type { OrgDetails } from './sfCli';

export function buildOrgUrl(org: OrgDetails): string {
  return `${org.instanceUrl}/secur/frontdoor.jsp?sid=${org.accessToken}`;
}

export function buildRecordUrl(org: OrgDetails, recordId: string): string {
  return `${org.instanceUrl}/${encodeURIComponent(recordId)}`;
}

/**
 * Lightning in-app record URL. No caller yet — kept deliberately, one is
 * planned. Drop the `@knipignore` when it lands, so the dead-export gate starts
 * covering this again.
 *
 * @knipignore
 */
export function buildRecordInAppUrl(org: OrgDetails, recordId: string, app: string): string {
  return `${org.instanceUrl}/lightning/app/${encodeURIComponent(app)}/r/${encodeURIComponent(recordId)}/view`;
}

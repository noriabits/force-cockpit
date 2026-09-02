import type { OrgDetails } from './sfCli';

export function buildOrgUrl(org: OrgDetails): string {
  return `${org.instanceUrl}/secur/frontdoor.jsp?sid=${org.accessToken}`;
}

export function buildRecordUrl(org: OrgDetails, recordId: string): string {
  return `${org.instanceUrl}/${encodeURIComponent(recordId)}`;
}

/**
 * Lightning in-app record URL: the record opened inside one named app rather
 * than wherever the Id redirect happens to land the viewer.
 *
 * `app` is a Lightning app API name (`Sales`, `Service`, `c__MyApp`), and only
 * a caller that already knows the org has one to give — which is why
 * `buildRecordUrl` stays the default and this is reached for deliberately.
 */
export function buildRecordInAppUrl(org: OrgDetails, recordId: string, app: string): string {
  return `${org.instanceUrl}/lightning/app/${encodeURIComponent(app)}/r/${encodeURIComponent(recordId)}/view`;
}

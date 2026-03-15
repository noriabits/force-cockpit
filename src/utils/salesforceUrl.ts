import type { OrgDetails } from './sfCli';

export function buildOrgUrl(org: OrgDetails): string {
  return `${org.instanceUrl}/secur/frontdoor.jsp?sid=${org.accessToken}`;
}

export function buildRecordUrl(org: OrgDetails, recordId: string): string {
  return `${buildOrgUrl(org)}&retURL=/${recordId}`;
}

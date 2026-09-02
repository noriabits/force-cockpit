import { describe, it, expect } from 'vitest';
import type { OrgDetails } from './sfCli';
import { buildOrgUrl, buildRecordInAppUrl, buildRecordUrl } from './salesforceUrl';

// Only the two fields the builders read; the rest of OrgDetails is irrelevant here.
const org = {
  instanceUrl: 'https://x.my.salesforce.com',
  accessToken: '00Dxx!token',
} as OrgDetails;

describe('salesforceUrl', () => {
  it('buildOrgUrl points the frontdoor at the session token', () => {
    expect(buildOrgUrl(org)).toBe(
      'https://x.my.salesforce.com/secur/frontdoor.jsp?sid=00Dxx!token',
    );
  });

  it('buildRecordUrl is the bare Id redirect, so Salesforce picks the app', () => {
    expect(buildRecordUrl(org, '001ABC')).toBe('https://x.my.salesforce.com/001ABC');
  });

  it('buildRecordInAppUrl pins the record to the named Lightning app', () => {
    expect(buildRecordInAppUrl(org, '001ABC', 'Sales')).toBe(
      'https://x.my.salesforce.com/lightning/app/Sales/r/001ABC/view',
    );
  });

  // The app name reaches this from a plugin, so it is not ours to trust: a `/`
  // would otherwise graft extra path segments onto the URL being opened.
  it('buildRecordInAppUrl encodes an app name that would escape its segment', () => {
    expect(buildRecordInAppUrl(org, '001ABC', 'a/b c')).toBe(
      'https://x.my.salesforce.com/lightning/app/a%2Fb%20c/r/001ABC/view',
    );
  });

  it('both record builders encode the record Id', () => {
    expect(buildRecordUrl(org, 'a b')).toBe('https://x.my.salesforce.com/a%20b');
    expect(buildRecordInAppUrl(org, 'a/b', 'Sales')).toBe(
      'https://x.my.salesforce.com/lightning/app/Sales/r/a%2Fb/view',
    );
  });
});

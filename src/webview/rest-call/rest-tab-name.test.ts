import { describe, expect, it } from 'vitest';
import { endpointBaseName } from './rest-tab-name';

describe('endpointBaseName', () => {
  it('names a request after the last path segment', () => {
    expect(endpointBaseName('/services/data/v65.0/sobjects/Account', 'GET')).toBe('Account');
  });

  it('uses a record id when the endpoint addresses one', () => {
    expect(endpointBaseName('/services/data/v65.0/sobjects/Account/001xx', 'GET')).toBe('001xx');
  });

  it('names an Apex REST endpoint after its last segment', () => {
    expect(endpointBaseName('/services/apexrest/MyService/v1', 'POST')).toBe('v1');
  });

  it('ignores trailing slashes', () => {
    expect(endpointBaseName('/services/data/v65.0/sobjects/Contact///', 'GET')).toBe('Contact');
  });

  it('strips a query string', () => {
    expect(endpointBaseName('/services/data/v65.0/query?q=SELECT+Id', 'GET')).toBe('query');
  });

  it('strips a fragment', () => {
    expect(endpointBaseName('/services/data/limits#top', 'GET')).toBe('limits');
  });

  it('skips past an absolute URL host, which every endpoint would share', () => {
    expect(endpointBaseName('https://my.salesforce.com/services/data/v65.0/limits', 'GET')).toBe(
      'limits',
    );
  });

  it('falls back to the verb when an absolute URL has no path', () => {
    expect(endpointBaseName('https://my.salesforce.com', 'GET')).toBe('GET Request');
  });

  it('falls back to the verb for a blank endpoint, so new tabs differ by method', () => {
    expect(endpointBaseName('', 'POST')).toBe('POST Request');
    expect(endpointBaseName('   ', 'DELETE')).toBe('DELETE Request');
    expect(endpointBaseName('/', 'PATCH')).toBe('PATCH Request');
  });

  it('normalises the verb and defaults it when blank', () => {
    expect(endpointBaseName('', 'post')).toBe('POST Request');
    expect(endpointBaseName('', '')).toBe('GET Request');
  });
});

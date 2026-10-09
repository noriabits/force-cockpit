import { describe, expect, it, vi } from 'vitest';
import { RecordDetailService } from './RecordDetailService';
import type { DescribeService } from '../../../services/describe/DescribeService';
import type { FieldAccessService } from '../../../services/permissions/FieldAccessService';
import type { RestCallResult, RestCallService } from '../../../services/rest/RestCallService';

const ID = '001000000000001AAA';

const FIELDS = [
  { name: 'Id', label: 'Account ID', type: 'id', updateable: false },
  { name: 'Name', label: 'Account Name', type: 'string', updateable: true },
];

function ok(body: unknown, status = 200): RestCallResult {
  return { status, statusText: 'OK', headers: {}, body };
}

function makeDescribe(overrides: Partial<Record<keyof DescribeService, unknown>> = {}) {
  return {
    describeGlobal: vi.fn().mockResolvedValue({
      sobjects: [{ name: 'Account', label: 'Account', keyPrefix: '001' }],
    }),
    describeGlobalFresh: vi.fn().mockResolvedValue({ sobjects: [] }),
    describeSObject: vi.fn(),
    describeSObjectFresh: vi.fn().mockResolvedValue({ name: 'Account', fields: FIELDS }),
    ...overrides,
  } as unknown as DescribeService;
}

/** No FieldDefinition (no View Setup) and no grants, unless a test says otherwise. */
function fakeAccess(overrides: Partial<Record<keyof FieldAccessService, unknown>> = {}) {
  return {
    fieldDefinitions: vi.fn().mockResolvedValue(null),
    grants: vi.fn().mockResolvedValue(new Map()),
    ...overrides,
  } as unknown as FieldAccessService;
}

function makeRest(send: (...args: unknown[]) => Promise<RestCallResult>) {
  return { send: vi.fn(send) } as unknown as RestCallService & {
    send: ReturnType<typeof vi.fn>;
  };
}

const RECORD_BODY = {
  attributes: { type: 'Account', url: '/x' },
  Id: ID,
  Name: 'Acme',
};

describe('RecordDetailService.load', () => {
  it('reads the record over REST, with the schema from a FRESH describe', async () => {
    const describeService = makeDescribe();
    const rest = makeRest(async () => ok(RECORD_BODY));
    const svc = new RecordDetailService(describeService, rest, fakeAccess(), () => '65.0');

    const result = await svc.load(ID.slice(0, 15));

    expect(rest.send).toHaveBeenCalledWith(
      'GET',
      `/services/data/v65.0/sobjects/Account/${ID}`,
      '',
      [],
      undefined,
    );
    expect(describeService.describeSObjectFresh).toHaveBeenCalledWith('Account');
    expect(describeService.describeSObject).not.toHaveBeenCalled();
    expect(result).toEqual({
      objectName: 'Account',
      objectLabel: 'Account',
      id: ID,
      fields: FIELDS,
      values: { Id: ID, Name: 'Acme' }, // attributes stripped
      access: {},
      hiddenFields: [],
    });
  });

  it('retries the key-prefix lookup with a fresh global describe on a cache miss', async () => {
    const describeService = makeDescribe({
      describeGlobal: vi.fn().mockResolvedValue({ sobjects: [] }),
      describeGlobalFresh: vi.fn().mockResolvedValue({
        sobjects: [{ name: 'Account', label: 'Account', keyPrefix: '001' }],
      }),
    });
    const svc = new RecordDetailService(
      describeService,
      makeRest(async () => ok(RECORD_BODY)),
      fakeAccess(),
      () => '65.0',
    );

    await expect(svc.load(ID)).resolves.toMatchObject({ objectName: 'Account' });
    expect(describeService.describeGlobalFresh).toHaveBeenCalledTimes(1);
  });

  it('surfaces the Salesforce error verbatim on a failed read', async () => {
    const rest = makeRest(async () => ({
      status: 404,
      statusText: 'Not Found',
      headers: {},
      body: [{ errorCode: 'NOT_FOUND', message: 'The requested resource does not exist' }],
    }));
    const svc = new RecordDetailService(makeDescribe(), rest, fakeAccess(), () => '65.0');

    await expect(svc.load(ID)).rejects.toThrow(
      '404 Not Found — NOT_FOUND: The requested resource does not exist',
    );
  });

  it('stops before the read once aborted', async () => {
    const ac = new AbortController();
    const describeService = makeDescribe({
      describeSObjectFresh: vi.fn(async () => {
        ac.abort();
        return { name: 'Account', fields: FIELDS };
      }),
    });
    const rest = makeRest(async () => ok(RECORD_BODY));
    const svc = new RecordDetailService(describeService, rest, fakeAccess(), () => '65.0');

    await expect(svc.load(ID, ac.signal)).rejects.toThrow('Operation cancelled');
    expect(rest.send).not.toHaveBeenCalled();
  });
});

describe('RecordDetailService.save', () => {
  it('PATCHes only the changes it is given, then re-reads the record', async () => {
    const rest = makeRest(async (method) =>
      method === 'PATCH' ? ok(undefined, 204) : ok({ ...RECORD_BODY, Name: 'Acme 2' }),
    );
    const svc = new RecordDetailService(makeDescribe(), rest, fakeAccess(), () => '65.0');

    const result = await svc.save('Account', ID, { Name: 'Acme 2', Phone: null });

    expect(rest.send).toHaveBeenNthCalledWith(
      1,
      'PATCH',
      `/services/data/v65.0/sobjects/Account/${ID}`,
      JSON.stringify({ Name: 'Acme 2', Phone: null }),
      [],
      undefined,
    );
    expect(result.values.Name).toBe('Acme 2');
  });

  it('surfaces a validation-rule failure verbatim and does not re-read', async () => {
    const rest = makeRest(async () => ({
      status: 400,
      statusText: 'Bad Request',
      headers: {},
      body: [{ errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: 'Name is too short' }],
    }));
    const svc = new RecordDetailService(makeDescribe(), rest, fakeAccess(), () => '65.0');

    await expect(svc.save('Account', ID, { Name: 'A' })).rejects.toThrow(
      '400 Bad Request — FIELD_CUSTOM_VALIDATION_EXCEPTION: Name is too short',
    );
    expect(rest.send).toHaveBeenCalledTimes(1);
  });

  it('refuses an object name that could escape the URL path', async () => {
    const rest = makeRest(async () => ok(undefined, 204));
    const svc = new RecordDetailService(makeDescribe(), rest, fakeAccess(), () => '65.0');

    await expect(svc.save('Account/../User', ID, { Name: 'x' })).rejects.toThrow(
      /Invalid object name/,
    );
    expect(rest.send).not.toHaveBeenCalled();
  });

  it('refuses an empty change set', async () => {
    const rest = makeRest(async () => ok(undefined, 204));
    const svc = new RecordDetailService(makeDescribe(), rest, fakeAccess(), () => '65.0');

    await expect(svc.save('Account', ID, {})).rejects.toThrow('Nothing to save.');
    expect(rest.send).not.toHaveBeenCalled();
  });
});

describe('RecordDetailService field-level security notes', () => {
  const RESTRICTED_FIELDS = [
    ...FIELDS,
    // Writable by nature, but FLS grants this user Read only.
    { name: 'Rating', label: 'Rating', type: 'picklist', permissionable: true },
    // Read-only by nature: audit field (not permissionable) and a formula.
    { name: 'CreatedDate', label: 'Created Date', type: 'datetime', permissionable: false },
    { name: 'Score__c', label: 'Score', type: 'double', permissionable: true, calculated: true },
  ];

  function loadWith(access: FieldAccessService) {
    const describeService = makeDescribe({
      describeSObjectFresh: vi
        .fn()
        .mockResolvedValue({ name: 'Account', fields: RESTRICTED_FIELDS }),
    });
    const svc = new RecordDetailService(
      describeService,
      makeRest(async () => ok(RECORD_BODY)),
      access,
      () => '65.0',
    );
    return svc.load(ID);
  }

  it('notes FLS-read-only and FLS-hidden fields, each with who grants the missing access', async () => {
    const grants = vi.fn(async (_entity: string, _fields: string[], access: string) =>
      access === 'edit'
        ? new Map([['rating', ['Sales_Ops (Permission Set)']]])
        : new Map([['secret__c', ['Finance (Permission Set Group)']]]),
    );
    const access = fakeAccess({
      fieldDefinitions: vi.fn().mockResolvedValue([
        ...RESTRICTED_FIELDS.map((f) => ({
          QualifiedApiName: f.name,
          Label: f.label,
          DataType: '',
        })),
        { QualifiedApiName: 'Secret__c', Label: 'Secret', DataType: 'Text(80)' },
      ]),
      grants,
    });

    const result = await loadWith(access);

    expect(result.access).toEqual({
      Rating: { kind: 'readOnly', grantedBy: ['Sales_Ops (Permission Set)'] },
      Secret__c: { kind: 'hidden', grantedBy: ['Finance (Permission Set Group)'] },
    });
    expect(result.hiddenFields).toEqual([{ name: 'Secret__c', label: 'Secret', type: 'Text(80)' }]);
    // One batched query per access level, for exactly the restricted fields.
    expect(grants).toHaveBeenCalledWith('Account', ['Rating'], 'edit');
    expect(grants).toHaveBeenCalledWith('Account', ['Secret__c'], 'read');
  });

  it('still loads the record when the setup-only lookups are unavailable', async () => {
    const access = fakeAccess({ grants: vi.fn().mockResolvedValue(null) });

    const result = await loadWith(access);

    expect(result.values.Name).toBe('Acme');
    expect(result.hiddenFields).toEqual([]);
    expect(result.access).toEqual({ Rating: { kind: 'readOnly', grantedBy: null } });
  });

  it('asks nothing about grants when no field is restricted', async () => {
    const access = fakeAccess();
    const svc = new RecordDetailService(
      makeDescribe(),
      makeRest(async () => ok(RECORD_BODY)),
      access,
      () => '65.0',
    );

    await svc.load(ID);

    expect(access.grants).not.toHaveBeenCalled();
  });
});

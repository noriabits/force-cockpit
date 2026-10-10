import { describe, expect, it } from 'vitest';
import type { RecordDetailData, RecordDetailField } from '../../../../shared/protocol';
import { dirtyCountOf, recordBaseName, sameRecordId } from './record-tab-name';

const ACCOUNT_ID = '001000000000001AAA';

function field(name: string, extra: Partial<RecordDetailField> = {}): RecordDetailField {
  return {
    name,
    label: name,
    type: 'string',
    referenceTo: [],
    picklistValues: [],
    inlineHelpText: null,
    required: false,
    custom: false,
    unique: false,
    externalId: false,
    filterable: true,
    sortable: true,
    groupable: true,
    updateable: true,
    calculated: false,
    ...extra,
  };
}

function record(
  values: Record<string, unknown>,
  fields: RecordDetailField[],
  extra: Partial<RecordDetailData> = {},
): RecordDetailData {
  return {
    objectName: 'Account',
    objectLabel: 'Account',
    id: ACCOUNT_ID,
    fields,
    values,
    access: {},
    hiddenFields: [],
    ...extra,
  };
}

describe('recordBaseName', () => {
  it('names a loaded record after its name field', () => {
    const results = record({ Name: '  Acme  ' }, [field('Id'), field('Name', { nameField: true })]);
    expect(recordBaseName({ recordId: ACCOUNT_ID, results }, 'Record')).toBe('Acme');
  });

  it('falls back to the object label and the Id tail when the object has no name field', () => {
    const results = record({ CommentBody: 'hi' }, [field('CommentBody')], {
      objectName: 'CaseComment',
      objectLabel: 'Case Comment',
      id: '00a000000000001AAA',
    });
    expect(recordBaseName({ recordId: '00a000000000001AAA', results }, 'Record')).toBe(
      'Case Comment 001AAA',
    );
  });

  it('falls back when the name field is blank or not a string', () => {
    const fields = [field('Name', { nameField: true })];
    expect(
      recordBaseName({ recordId: ACCOUNT_ID, results: record({ Name: '   ' }, fields) }, 'R'),
    ).toBe('Account 001AAA');
    expect(
      recordBaseName({ recordId: ACCOUNT_ID, results: record({ Name: null }, fields) }, 'R'),
    ).toBe('Account 001AAA');
  });

  it('names an unloaded tab after the Id it holds, and a blank tab after the caller’s word', () => {
    expect(recordBaseName({ recordId: ` ${ACCOUNT_ID} ` }, 'Record')).toBe(ACCOUNT_ID);
    expect(recordBaseName({ recordId: '', results: null }, 'Record')).toBe('Record');
    expect(recordBaseName({ recordId: '   ' }, 'Record')).toBe('Record');
  });

  it('keeps a restored tab’s own label until its record is loaded', () => {
    // The strip re-derives auto-named tabs on load, before any record is fetched.
    expect(recordBaseName({ recordId: ACCOUNT_ID, name: 'Acme' }, 'Record')).toBe('Acme');
    // Once loaded, the record wins over the stored label.
    const results = record({ Name: 'Acme Corp' }, [field('Name', { nameField: true })]);
    expect(recordBaseName({ recordId: ACCOUNT_ID, name: 'Acme', results }, 'Record')).toBe(
      'Acme Corp',
    );
  });
});

describe('sameRecordId', () => {
  it('matches the 15-char form against the 18-char one', () => {
    expect(sameRecordId('001000000000001', ACCOUNT_ID)).toBe(true);
    expect(sameRecordId(ACCOUNT_ID, ' 001000000000001 ')).toBe(true);
  });

  it('matches identical Ids and rejects different ones', () => {
    expect(sameRecordId(ACCOUNT_ID, ACCOUNT_ID)).toBe(true);
    expect(sameRecordId(ACCOUNT_ID, '001000000000002AAB')).toBe(false);
  });

  it('matches nothing when either side is not an Id — not even itself', () => {
    expect(sameRecordId('', '')).toBe(false);
    expect(sameRecordId('acme', 'acme')).toBe(false);
    expect(sameRecordId(ACCOUNT_ID, '')).toBe(false);
  });
});

describe('dirtyCountOf', () => {
  const fields = [field('Name'), field('Industry')];
  const rec = record({ Name: 'Acme', Industry: 'Tech' }, fields);

  it('counts only edits that differ from the record', () => {
    expect(dirtyCountOf(rec, {})).toBe(0);
    expect(dirtyCountOf(rec, { Name: 'Acme' })).toBe(0);
    expect(dirtyCountOf(rec, { Name: 'Acme Corp', Industry: 'Tech' })).toBe(1);
  });

  it('ignores edits for fields the record does not have, and no record at all', () => {
    expect(dirtyCountOf(rec, { Nope__c: 'x' })).toBe(0);
    expect(dirtyCountOf(null, { Name: 'Acme Corp' })).toBe(0);
  });
});

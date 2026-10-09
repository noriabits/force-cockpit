import { describe, expect, it } from 'vitest';
import type { RecordDetailField } from '../../../shared/protocol';
import { buildAccessNotes, hiddenFieldsOf, isFlsReadOnly } from './fieldAccess';

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
    ...extra,
  };
}

describe('isFlsReadOnly', () => {
  it('flags a permissionable field the user can neither create nor update', () => {
    expect(isFlsReadOnly(field('Rating', { permissionable: true }))).toBe(true);
  });

  it('does not flag a field the user can write', () => {
    expect(isFlsReadOnly(field('Name', { permissionable: true, updateable: true }))).toBe(false);
  });

  it('does not flag read-only-by-nature fields', () => {
    // Audit/system fields, Id and required fields: FLS never governs them.
    expect(isFlsReadOnly(field('CreatedDate', { permissionable: false }))).toBe(false);
    expect(isFlsReadOnly(field('Score__c', { permissionable: true, calculated: true }))).toBe(
      false,
    );
    expect(isFlsReadOnly(field('Number__c', { permissionable: true, autoNumber: true }))).toBe(
      false,
    );
    // Set on insert, fixed afterwards — read-only on an existing record whatever FLS says.
    expect(isFlsReadOnly(field('Insert__c', { permissionable: true, createable: true }))).toBe(
      false,
    );
  });

  it('does not guess when the describe carries no flags at all', () => {
    expect(isFlsReadOnly(field('Old'))).toBe(false);
  });
});

describe('hiddenFieldsOf', () => {
  const described = [field('Id'), field('Name')];

  it('lists defined fields the describe left out, matching names case-insensitively', () => {
    const defs = [
      { QualifiedApiName: 'Id', Label: 'Account ID', DataType: 'Lookup()' },
      { QualifiedApiName: 'name', Label: 'Account Name', DataType: 'Name' },
      { QualifiedApiName: 'Secret__c', Label: 'Secret', DataType: 'Text(80)' },
      { QualifiedApiName: 'Bare__c', Label: null, DataType: null },
    ];
    expect(hiddenFieldsOf(defs, described)).toEqual([
      { name: 'Secret__c', label: 'Secret', type: 'Text(80)' },
      { name: 'Bare__c', label: 'Bare__c', type: '' },
    ]);
  });

  it('claims nothing hidden when the full field list is unavailable', () => {
    expect(hiddenFieldsOf(null, described)).toEqual([]);
  });
});

describe('buildAccessNotes', () => {
  it('maps each restricted field to its grants, keeping "none" and "unknown" apart', () => {
    const notes = buildAccessNotes(
      ['Rating', 'Region__c'],
      ['Secret__c'],
      new Map([['rating', ['Sales_Ops (Permission Set)']]]),
      null,
    );
    expect(notes).toEqual({
      Rating: { kind: 'readOnly', grantedBy: ['Sales_Ops (Permission Set)'] },
      Region__c: { kind: 'readOnly', grantedBy: [] }, // lookup worked, nobody grants it
      Secret__c: { kind: 'hidden', grantedBy: null }, // lookup unavailable
    });
  });
});

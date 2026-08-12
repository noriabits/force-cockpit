import { describe, expect, it } from 'vitest';
import { fromObjectOfQuery, parseSoqlError } from './soqlErrorParser';

describe('parseSoqlError', () => {
  it('extracts the field and entity from a No such column error', () => {
    const message =
      '\nvlocity_cmt__LineNumber__c,AssetReferenceId__c\n                              ^\n' +
      'ERROR at Row:1:Column:38\n' +
      "No such column 'AssetReferenceId__c' on entity 'QuoteLineItem'. If you are attempting " +
      "to use a custom field, be sure to append the '__c' after the custom field name.";

    expect(parseSoqlError(message)).toEqual({
      kind: 'unknown-field',
      field: 'AssetReferenceId__c',
      entity: 'QuoteLineItem',
      row: 1,
      column: 38,
    });
  });

  it('accepts the sobject wording as well as entity', () => {
    const info = parseSoqlError("No such column 'Foo' on sobject 'Account'.");
    expect(info).toEqual({ kind: 'unknown-field', field: 'Foo', entity: 'Account' });
  });

  it('omits the position when Salesforce did not include one', () => {
    const info = parseSoqlError("No such column 'Foo__c' on entity 'Account'.");
    expect(info).toEqual({ kind: 'unknown-field', field: 'Foo__c', entity: 'Account' });
  });

  it('extracts a bad relationship', () => {
    const info = parseSoqlError("Didn't understand relationship 'Accont' in field path.");
    expect(info).toEqual({ kind: 'unknown-relationship', relationship: 'Accont' });
  });

  it('extracts an unsupported sObject type', () => {
    const info = parseSoqlError("sObject type 'Acount' is not supported.");
    expect(info).toEqual({ kind: 'unknown-object', object: 'Acount' });
  });

  it('extracts an Invalid type error', () => {
    const info = parseSoqlError('INVALID_TYPE: ... FROM Acount\n  ^\nInvalid type: Acount');
    expect(info).toEqual({ kind: 'unknown-object', object: 'Acount' });
  });

  it('returns null for messages it has nothing to add to', () => {
    expect(parseSoqlError('unexpected token: ORDER')).toBeNull();
    expect(parseSoqlError('MALFORMED_QUERY: unexpected token')).toBeNull();
    expect(parseSoqlError('')).toBeNull();
  });
});

describe('fromObjectOfQuery', () => {
  it('reads the FROM object', () => {
    expect(fromObjectOfQuery('SELECT Accont.Name FROM Contact WHERE Id != null')).toBe('Contact');
  });

  it('is case-insensitive', () => {
    expect(fromObjectOfQuery('select id from My_Object__c')).toBe('My_Object__c');
  });

  it('returns null when there is no FROM clause', () => {
    expect(fromObjectOfQuery('SELECT Id')).toBeNull();
  });
});

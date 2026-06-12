import { describe, it, expect } from 'vitest';
import { isSalesforceRecordId, computeIdSuffix, stripRecordAttributes } from './salesforce';

describe('computeIdSuffix', () => {
  it('returns AAA for an all-zero 15-char prefix', () => {
    expect(computeIdSuffix('001000000000001')).toBe('AAA');
  });
  it('returns BBB when each chunk has only its first char uppercase', () => {
    expect(computeIdSuffix('A0000B0000C0000')).toBe('BBB');
  });
  it('returns 555 when every char is uppercase A-Z', () => {
    expect(computeIdSuffix('AAAAAAAAAAAAAAA')).toBe('555');
  });
});

describe('isSalesforceRecordId', () => {
  it('accepts an 18-char Id whose checksum matches', () => {
    expect(isSalesforceRecordId('001000000000001AAA')).toBe(true);
    expect(isSalesforceRecordId('A0000B0000C0000BBB')).toBe(true);
  });
  it('rejects an 18-char string with lowercase in the suffix', () => {
    expect(isSalesforceRecordId('ServiceAccountTest')).toBe(false);
  });
  it('rejects an 18-char string with a wrong checksum', () => {
    expect(isSalesforceRecordId('AAAAAAAAAAAAAAAAAA')).toBe(false);
  });
  it('rejects strings of any length other than 18', () => {
    expect(isSalesforceRecordId('001000000000001')).toBe(false);
    expect(isSalesforceRecordId('001000000000001AA')).toBe(false);
    expect(isSalesforceRecordId('001000000000001AAAA')).toBe(false);
    expect(isSalesforceRecordId('')).toBe(false);
  });
  it('rejects non-strings', () => {
    expect(isSalesforceRecordId(null)).toBe(false);
    expect(isSalesforceRecordId(undefined)).toBe(false);
    expect(isSalesforceRecordId(12345)).toBe(false);
  });
  it('rejects strings with non-alphanumeric characters', () => {
    expect(isSalesforceRecordId('001-00000000001AAA')).toBe(false);
    expect(isSalesforceRecordId('Acme Inc 12345 ZZZ')).toBe(false);
  });
});

describe('stripRecordAttributes', () => {
  it('removes the top-level attributes key', () => {
    const record = {
      attributes: { type: 'Account', url: '/services/data/v65.0/sobjects/Account/001' },
      Id: '001',
      Name: 'Acme',
    };
    expect(stripRecordAttributes(record)).toEqual({ Id: '001', Name: 'Acme' });
  });

  it('strips attributes from every record in an array', () => {
    const records = [
      { attributes: { type: 'Account' }, Id: '001' },
      { attributes: { type: 'Account' }, Id: '002' },
    ];
    expect(stripRecordAttributes(records)).toEqual([{ Id: '001' }, { Id: '002' }]);
  });

  it('strips attributes from nested subquery records', () => {
    const record = {
      attributes: { type: 'Account' },
      Id: '001',
      Opportunities: {
        totalSize: 1,
        done: true,
        records: [{ attributes: { type: 'Opportunity' }, Name: 'Deal' }],
      },
    };
    expect(stripRecordAttributes(record)).toEqual({
      Id: '001',
      Opportunities: { totalSize: 1, done: true, records: [{ Name: 'Deal' }] },
    });
  });

  it('leaves primitives and null untouched', () => {
    expect(stripRecordAttributes(null)).toBeNull();
    expect(stripRecordAttributes('x')).toBe('x');
    expect(stripRecordAttributes(42)).toBe(42);
  });
});

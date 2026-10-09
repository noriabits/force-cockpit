import { describe, expect, it } from 'vitest';
import { normalizeRecordId, resolveObjectByKeyPrefix } from './recordId';

const ID18 = '001000000000001AAA';
const ID15 = ID18.slice(0, 15);

describe('normalizeRecordId', () => {
  it('returns an 18-char Id unchanged, trimmed', () => {
    expect(normalizeRecordId(`  ${ID18}\n`)).toBe(ID18);
  });

  it('appends the case-safe suffix to a 15-char Id', () => {
    expect(normalizeRecordId(ID15)).toBe(ID18);
  });

  it('derives the suffix from case, so two 15-char Ids differing only in case stay distinct', () => {
    expect(normalizeRecordId('001aB0000000001')).not.toBe(normalizeRecordId('001Ab0000000001'));
  });

  it('rejects an 18-char Id with a bad checksum', () => {
    expect(() => normalizeRecordId('001000000000001AAB')).toThrow(/not a Salesforce record Id/);
  });

  it('rejects wrong lengths and punctuation', () => {
    expect(() => normalizeRecordId('001000')).toThrow(/not a Salesforce record Id/);
    expect(() => normalizeRecordId('001000000000001-')).toThrow(/not a Salesforce record Id/);
    expect(() => normalizeRecordId('')).toThrow(/not a Salesforce record Id/);
  });
});

describe('resolveObjectByKeyPrefix', () => {
  const sobjects = [
    { name: 'Account', label: 'Account', keyPrefix: '001' },
    { name: 'AccountHistory', label: 'Account History', keyPrefix: null },
    { name: 'Contact', label: 'Contact', keyPrefix: '003' },
  ];

  it('matches on the first three characters', () => {
    expect(resolveObjectByKeyPrefix(sobjects, '003000000000001AAA').name).toBe('Contact');
  });

  it('never matches an object with no key prefix', () => {
    expect(() => resolveObjectByKeyPrefix(sobjects, 'nul000000000001AAA')).toThrow(
      /key prefix "nul"/,
    );
  });

  it('reports the prefix when no object owns it', () => {
    expect(() => resolveObjectByKeyPrefix(sobjects, 'a0X000000000001AAA')).toThrow(
      /key prefix "a0X"/,
    );
  });
});

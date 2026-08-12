import { describe, expect, it } from 'vitest';
import { suggestNames } from './nameSuggest';

const ACCOUNT_FIELDS = [
  'Id',
  'Name',
  'AccountNumber',
  'AnnualRevenue',
  'BillingCity',
  'OwnerId',
  'Industry',
  'ParentId',
];

describe('suggestNames', () => {
  it('ranks a single-character typo first', () => {
    expect(suggestNames('Nmae', ACCOUNT_FIELDS)[0]).toBe('Name');
  });

  it('ranks a prefix match above an edit-distance match', () => {
    const result = suggestNames('Account', ACCOUNT_FIELDS);
    expect(result[0]).toBe('AccountNumber');
  });

  it('is case-insensitive but preserves the candidate casing', () => {
    expect(suggestNames('name', ACCOUNT_FIELDS)).toContain('Name');
  });

  it('returns nothing when nothing is close', () => {
    expect(suggestNames('vlocity_cmt__TotallyDifferent__c', ACCOUNT_FIELDS)).toEqual([]);
  });

  it('caps the number of suggestions', () => {
    const many = Array.from({ length: 40 }, (_, i) => `Field${i}__c`);
    expect(suggestNames('Field__c', many, 3)).toHaveLength(3);
  });

  it('deduplicates candidates differing only in casing', () => {
    expect(suggestNames('name', ['Name', 'NAME', 'name'])).toEqual(['Name']);
  });

  it('returns an empty list for an empty target', () => {
    expect(suggestNames('', ACCOUNT_FIELDS)).toEqual([]);
  });

  it('tolerates more edits on a long name than a short one', () => {
    expect(suggestNames('AssetReferenceld__c', ['AssetReferenceId__c'])).toEqual([
      'AssetReferenceId__c',
    ]);
    expect(suggestNames('Id', ['Xy'])).toEqual([]);
  });
});

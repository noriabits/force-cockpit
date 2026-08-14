import { describe, expect, it } from 'vitest';
import { filterAndRankByMatch, matchRank, matchesToken } from './match-rank';

describe('matchRank', () => {
  it('ranks an exact match ahead of a prefix match', () => {
    expect(matchRank('city', 'City')).toBe(0);
    expect(matchRank('city', 'City__c')).toBe(1);
  });

  it('ranks a prefix match ahead of a mid-string match', () => {
    expect(matchRank('city', 'City__c')).toBeLessThan(matchRank('city', 'Vlocity_cmt__City__c')!);
  });

  it('is case-insensitive', () => {
    expect(matchRank('CITY', 'city__c')).toBe(1);
  });

  it('returns null when the token is absent', () => {
    expect(matchRank('zzz', 'City__c')).toBeNull();
  });

  it('treats an empty token as matching everything at rank 0', () => {
    expect(matchRank('', 'City__c')).toBe(0);
  });
});

describe('matchesToken', () => {
  it('mirrors matchRank non-null-ness', () => {
    expect(matchesToken('city', 'Vlocity_cmt__City__c')).toBe(true);
    expect(matchesToken('zzz', 'City__c')).toBe(false);
  });
});

describe('filterAndRankByMatch', () => {
  it('puts prefix matches before mid-string matches, dropping non-matches', () => {
    const fields = ['Vlocity_cmt__City__c', 'City__c', 'BillingCity', 'Name'];
    const result = filterAndRankByMatch(fields, 'city', (f) => f);
    expect(result).toEqual(['City__c', 'BillingCity', 'Vlocity_cmt__City__c']);
  });

  it('breaks ties alphabetically within the same rank', () => {
    const fields = ['Zebra__c', 'City__c', 'Ant__c'];
    const result = filterAndRankByMatch(fields, '', (f) => f);
    expect(result).toEqual(['Ant__c', 'City__c', 'Zebra__c']);
  });

  it('works over objects via the getText projection', () => {
    const items = [{ name: 'Vlocity_cmt__City__c' }, { name: 'City__c' }];
    const result = filterAndRankByMatch(items, 'city', (i) => i.name);
    expect(result.map((i) => i.name)).toEqual(['City__c', 'Vlocity_cmt__City__c']);
  });
});

import { describe, it, expect } from 'vitest';
import { compareNames, compareByName } from './compareNames';

const sorted = (names: string[]) => [...names].sort(compareNames);

describe('compareNames', () => {
  it('sorts plain names alphabetically, case-insensitively', () => {
    expect(sorted(['banana', 'Apple', 'cherry'])).toEqual(['Apple', 'banana', 'cherry']);
  });

  it('ignores a leading emoji so names order by their readable label', () => {
    expect(sorted(['🔥 Zebra', '🟢 Apple', '💥 Mango'])).toEqual([
      '🟢 Apple',
      '💥 Mango',
      '🔥 Zebra',
    ]);
  });

  it('lets a numeric or letter prefix pin a name to the top of an emoji-prefixed list', () => {
    expect(sorted(['🔥 Zebra', '🟢 Apple', '0 Pinned', 'A Second'])).toEqual([
      '0 Pinned',
      'A Second',
      '🟢 Apple',
      '🔥 Zebra',
    ]);
  });

  it('ignores other leading symbols and whitespace', () => {
    expect(sorted(['- Beta', '_Alpha', '  Gamma'])).toEqual(['_Alpha', '- Beta', '  Gamma']);
  });

  it('only strips up to the first alphanumeric — "[X] Beta" sorts under X', () => {
    expect(sorted(['[X] Beta', 'Alpha', 'Yankee'])).toEqual(['Alpha', '[X] Beta', 'Yankee']);
  });

  it('orders embedded numbers naturally', () => {
    expect(sorted(['Step 10', 'Step 2', 'Step 1'])).toEqual(['Step 1', 'Step 2', 'Step 10']);
  });

  it('falls back to the raw name when it is all symbols', () => {
    expect(sorted(['🔥', '💥'])).toEqual(['💥', '🔥']);
  });

  it('is a stable tiebreak for names differing only by prefix', () => {
    expect(compareNames('🔥 Report', '🟢 Report')).not.toBe(0);
    expect(compareNames('🔥 Report', '🔥 Report')).toBe(0);
  });

  it('compareByName reads the name off an item', () => {
    const items = [{ name: '🔥 Zebra' }, { name: '🟢 Apple' }];
    expect([...items].sort(compareByName).map((i) => i.name)).toEqual(['🟢 Apple', '🔥 Zebra']);
  });
});

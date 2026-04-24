import { describe, expect, it } from 'vitest';
import { toSlug } from './slug';

describe('toSlug', () => {
  it('converts name to kebab-case', () => {
    expect(toSlug('My Script Name')).toBe('my-script-name');
  });

  it('replaces multiple special characters with a single hyphen', () => {
    expect(toSlug('Hello  World!!')).toBe('hello-world');
  });

  it('strips leading and trailing hyphens', () => {
    expect(toSlug('  ---name---  ')).toBe('name');
  });

  it('falls back to "item" for an empty result by default', () => {
    expect(toSlug('!!!!')).toBe('item');
  });

  it('uses the provided fallback when the result is empty', () => {
    expect(toSlug('!!!!', 'script')).toBe('script');
    expect(toSlug('', 'chart')).toBe('chart');
  });
});

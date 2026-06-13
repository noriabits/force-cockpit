import { describe, expect, it } from 'vitest';
import { buildGitignoreMatcher } from './gitignoreFilter';

describe('buildGitignoreMatcher', () => {
  it('always ignores the .git directory', () => {
    const isIgnored = buildGitignoreMatcher();
    expect(isIgnored('.git/config')).toBe(true);
    expect(isIgnored('src/extension.ts')).toBe(false);
  });

  it('ignores directory patterns and their contents', () => {
    const isIgnored = buildGitignoreMatcher(['force-cockpit/private/\nnode_modules/']);
    expect(isIgnored('force-cockpit/private/scripts/secret.yaml')).toBe(true);
    expect(isIgnored('node_modules/foo/index.js')).toBe(true);
    expect(isIgnored('force-cockpit/scripts/shared.yaml')).toBe(false);
  });

  it('honors glob and extension patterns', () => {
    const isIgnored = buildGitignoreMatcher(['*.log', 'dist/']);
    expect(isIgnored('logs/app.log')).toBe(true);
    expect(isIgnored('dist/extension.js')).toBe(true);
    expect(isIgnored('src/app.ts')).toBe(false);
  });

  it('honors negation patterns', () => {
    const isIgnored = buildGitignoreMatcher(['*.log\n!important.log']);
    expect(isIgnored('debug.log')).toBe(true);
    expect(isIgnored('important.log')).toBe(false);
  });

  it('normalizes backslashes and leading slashes', () => {
    const isIgnored = buildGitignoreMatcher(['private/']);
    expect(isIgnored('private\\secret.txt')).toBe(true);
    expect(isIgnored('/private/secret.txt')).toBe(true);
  });

  it('returns false for empty paths', () => {
    const isIgnored = buildGitignoreMatcher(['*']);
    expect(isIgnored('')).toBe(false);
  });
});

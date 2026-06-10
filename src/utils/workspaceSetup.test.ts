import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureUserFolders } from './workspaceSetup';

describe('ensureUserFolders', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wssetup-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates all four folders and a private .gitignore', () => {
    ensureUserFolders(tmpDir);
    expect(fs.existsSync(path.join(tmpDir, 'scripts'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'monitoring'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'private', 'scripts'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'private', 'monitoring'))).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, 'private', '.gitignore'), 'utf8')).toBe('*\n');
  });

  it('does not overwrite an existing private .gitignore', () => {
    fs.mkdirSync(path.join(tmpDir, 'private'), { recursive: true });
    const gitignore = path.join(tmpDir, 'private', '.gitignore');
    fs.writeFileSync(gitignore, 'custom\n', 'utf8');
    ensureUserFolders(tmpDir);
    expect(fs.readFileSync(gitignore, 'utf8')).toBe('custom\n');
  });

  it('is idempotent on re-run', () => {
    ensureUserFolders(tmpDir);
    expect(() => ensureUserFolders(tmpDir)).not.toThrow();
    expect(fs.readFileSync(path.join(tmpDir, 'private', '.gitignore'), 'utf8')).toBe('*\n');
  });

  it('no-ops on a relative path', () => {
    ensureUserFolders('relative/path');
    expect(fs.existsSync('relative/path')).toBe(false);
  });
});

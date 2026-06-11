import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { splitItemId, resolveYamlPath, checkDuplicateId, deleteYamlItem } from './yamlRepository';

function write(baseDir: string, folder: string, name: string, content = 'name: X'): void {
  const dir = path.join(baseDir, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content, 'utf8');
}

describe('yamlRepository', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yamlrepo-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('splitItemId', () => {
    it('splits a simple id', () => {
      expect(splitItemId('orders/by-status')).toEqual({ folder: 'orders', basename: 'by-status' });
    });

    it('splits a nested id keeping the sub-folder in folder', () => {
      expect(splitItemId('orders/emea/regional')).toEqual({
        folder: 'orders/emea',
        basename: 'regional',
      });
    });

    it('handles an id with no folder', () => {
      expect(splitItemId('lonely')).toEqual({ folder: '', basename: 'lonely' });
    });
  });

  describe('resolveYamlPath', () => {
    it('returns the .yaml path when it exists', () => {
      write(tmpDir, 'cat', 'item.yaml');
      expect(resolveYamlPath(tmpDir, 'cat', 'item')).toBe(path.join(tmpDir, 'cat', 'item.yaml'));
    });

    it('falls back to .yml when .yaml is absent', () => {
      write(tmpDir, 'cat', 'item.yml');
      expect(resolveYamlPath(tmpDir, 'cat', 'item')).toBe(path.join(tmpDir, 'cat', 'item.yml'));
    });

    it('prefers .yaml over .yml when both exist', () => {
      write(tmpDir, 'cat', 'item.yaml');
      write(tmpDir, 'cat', 'item.yml');
      expect(resolveYamlPath(tmpDir, 'cat', 'item')).toBe(path.join(tmpDir, 'cat', 'item.yaml'));
    });

    it('returns null when neither exists', () => {
      expect(resolveYamlPath(tmpDir, 'cat', 'missing')).toBeNull();
    });
  });

  describe('checkDuplicateId', () => {
    it('does nothing when the other base path is empty', () => {
      expect(() =>
        checkDuplicateId('cat/x', '', { noun: 'config', otherLabel: 'private' }),
      ).not.toThrow();
    });

    it('does nothing when the other base path does not exist', () => {
      expect(() =>
        checkDuplicateId('cat/x', path.join(tmpDir, 'nope'), {
          noun: 'config',
          otherLabel: 'private',
        }),
      ).not.toThrow();
    });

    it('throws with the noun + label when a conflicting file exists (.yaml)', () => {
      write(tmpDir, 'cat', 'x.yaml');
      expect(() =>
        checkDuplicateId('cat/x', tmpDir, { noun: 'config', otherLabel: 'private' }),
      ).toThrow(/A config with the same category and name already exists in the private folder/);
    });

    it('also detects a conflicting .yml file', () => {
      write(tmpDir, 'cat', 'x.yml');
      expect(() =>
        checkDuplicateId('cat/x', tmpDir, { noun: 'script', otherLabel: 'shared' }),
      ).toThrow(/already exists in the shared folder/);
    });

    it('does not throw when no conflict', () => {
      write(tmpDir, 'cat', 'other.yaml');
      expect(() =>
        checkDuplicateId('cat/x', tmpDir, { noun: 'config', otherLabel: 'private' }),
      ).not.toThrow();
    });
  });

  describe('deleteYamlItem', () => {
    it('deletes a .yaml file', () => {
      write(tmpDir, 'cat', 'x.yaml');
      deleteYamlItem(tmpDir, 'cat/x', 'config');
      expect(fs.existsSync(path.join(tmpDir, 'cat', 'x.yaml'))).toBe(false);
    });

    it('deletes a .yml file', () => {
      write(tmpDir, 'cat', 'x.yml');
      deleteYamlItem(tmpDir, 'cat/x', 'config');
      expect(fs.existsSync(path.join(tmpDir, 'cat', 'x.yml'))).toBe(false);
    });

    it('throws with the noun when the file is missing', () => {
      expect(() => deleteYamlItem(tmpDir, 'cat/missing', 'config')).toThrow(
        /Cannot delete: config not found/,
      );
    });
  });
});

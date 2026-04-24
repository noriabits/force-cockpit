import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScriptRepository } from './ScriptRepository';

function writeScript(baseDir: string, folder: string, name: string, content: string): void {
  const dir = path.join(baseDir, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content, 'utf8');
}

describe('ScriptRepository', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('save', () => {
    it('saves a shared script to userPath', () => {
      const userDir = path.join(tmpDir, 'user');
      const repo = new ScriptRepository({
        userPath: userDir,
        privatePath: '',
        workspaceRoot: '',
      });

      const saved = repo.save({
        name: 'My Script',
        description: '',
        type: 'apex',
        script: "System.debug('x');",
        folder: 'cat',
        inputs: [],
      });

      expect(saved.source).toBe('user');
      expect(fs.existsSync(path.join(userDir, 'cat', 'my-script.yaml'))).toBe(true);
    });

    it('saves a private script to privatePath', () => {
      const privateDir = path.join(tmpDir, 'private');
      const repo = new ScriptRepository({
        userPath: path.join(tmpDir, 'user'),
        privatePath: privateDir,
        workspaceRoot: '',
      });

      const saved = repo.save(
        {
          name: 'My Private Script',
          description: '',
          type: 'apex',
          script: "System.debug('x');",
          folder: 'cat',
          inputs: [],
        },
        true,
      );

      expect(saved.source).toBe('private');
      expect(fs.existsSync(path.join(privateDir, 'cat', 'my-private-script.yaml'))).toBe(true);
    });

    it('throws when saving a private script that conflicts with a shared one', () => {
      const userDir = path.join(tmpDir, 'user');
      const privateDir = path.join(tmpDir, 'private');
      writeScript(userDir, 'cat', 'my-script.yaml', `name: My Script\napex: shared()`);

      const repo = new ScriptRepository({
        userPath: userDir,
        privatePath: privateDir,
        workspaceRoot: '',
      });

      expect(() =>
        repo.save(
          {
            name: 'My Script',
            description: '',
            type: 'apex',
            script: 'private()',
            folder: 'cat',
            inputs: [],
          },
          true,
        ),
      ).toThrow();
    });

    it('throws when saving a shared script that conflicts with a private one', () => {
      const userDir = path.join(tmpDir, 'user');
      const privateDir = path.join(tmpDir, 'private');
      writeScript(privateDir, 'cat', 'my-script.yaml', `name: My Script\napex: private()`);

      const repo = new ScriptRepository({
        userPath: userDir,
        privatePath: privateDir,
        workspaceRoot: '',
      });

      expect(() =>
        repo.save(
          {
            name: 'My Script',
            description: '',
            type: 'apex',
            script: 'shared()',
            folder: 'cat',
            inputs: [],
          },
          false,
        ),
      ).toThrow();
    });

    it('return value includes filterUserDebug and formatJson for apex', () => {
      const userDir = path.join(tmpDir, 'user');
      const repo = new ScriptRepository({
        userPath: userDir,
        privatePath: '',
        workspaceRoot: '',
      });
      const saved = repo.save({
        name: 'S',
        description: '',
        type: 'apex',
        script: 'System.debug();',
        folder: 'cat',
        filterUserDebug: true,
        formatJson: true,
        inputs: [],
      });
      expect(saved.filterUserDebug).toBe(true);
      expect(saved.formatJson).toBe(true);
    });
  });

  describe('update', () => {
    it('moves script from userPath to privatePath when privacy changes', () => {
      const userDir = path.join(tmpDir, 'user');
      const privateDir = path.join(tmpDir, 'private');
      writeScript(userDir, 'cat', 'my-script.yaml', `name: My Script\napex: shared()`);

      const repo = new ScriptRepository({
        userPath: userDir,
        privatePath: privateDir,
        workspaceRoot: '',
      });

      repo.update(
        'cat/my-script',
        {
          name: 'My Script',
          description: '',
          type: 'apex',
          script: 'private()',
          folder: 'cat',
          inputs: [],
        },
        true,
        false,
      );

      expect(fs.existsSync(path.join(userDir, 'cat', 'my-script.yaml'))).toBe(false);
      expect(fs.existsSync(path.join(privateDir, 'cat', 'my-script.yaml'))).toBe(true);
    });
  });

  describe('delete', () => {
    it('deletes a script from privatePath when isPrivate=true', () => {
      const privateDir = path.join(tmpDir, 'private');
      writeScript(privateDir, 'cat', 'my-script.yaml', `name: My Script\napex: private()`);

      const repo = new ScriptRepository({
        userPath: path.join(tmpDir, 'user'),
        privatePath: privateDir,
        workspaceRoot: '',
      });
      repo.delete('cat/my-script', true);

      expect(fs.existsSync(path.join(privateDir, 'cat', 'my-script.yaml'))).toBe(false);
    });

    it('throws when the file does not exist', () => {
      const repo = new ScriptRepository({
        userPath: path.join(tmpDir, 'user'),
        privatePath: '',
        workspaceRoot: '',
      });
      expect(() => repo.delete('cat/missing', false)).toThrow(/not found/);
    });
  });

  describe('YAML serialization', () => {
    it('saves filter-user-debug: true for apex scripts that set the flag', () => {
      const userDir = path.join(tmpDir, 'user');
      const repo = new ScriptRepository({
        userPath: userDir,
        privatePath: '',
        workspaceRoot: '',
      });
      repo.save({
        name: 'S',
        description: '',
        type: 'apex',
        script: 'System.debug();',
        folder: 'cat',
        filterUserDebug: true,
      });
      const content = fs.readFileSync(path.join(userDir, 'cat', 's.yaml'), 'utf8');
      const doc = yaml.load(content) as Record<string, unknown>;
      expect(doc['filter-user-debug']).toBe(true);
      expect(doc['format-json']).toBeUndefined();
    });

    it('saves format-json: true for apex scripts that set the flag', () => {
      const userDir = path.join(tmpDir, 'user');
      const repo = new ScriptRepository({
        userPath: userDir,
        privatePath: '',
        workspaceRoot: '',
      });
      repo.save({
        name: 'S',
        description: '',
        type: 'apex',
        script: 'System.debug();',
        folder: 'cat',
        formatJson: true,
      });
      const content = fs.readFileSync(path.join(userDir, 'cat', 's.yaml'), 'utf8');
      const doc = yaml.load(content) as Record<string, unknown>;
      expect(doc['format-json']).toBe(true);
    });

    it('does not save apex-only flags on command/js scripts', () => {
      const userDir = path.join(tmpDir, 'user');
      const repo = new ScriptRepository({
        userPath: userDir,
        privatePath: '',
        workspaceRoot: '',
      });
      repo.save({
        name: 'C',
        description: '',
        type: 'command',
        script: 'echo hi',
        folder: 'cat',
        filterUserDebug: true,
        formatJson: true,
      });
      const content = fs.readFileSync(path.join(userDir, 'cat', 'c.yaml'), 'utf8');
      const doc = yaml.load(content) as Record<string, unknown>;
      expect(doc['filter-user-debug']).toBeUndefined();
      expect(doc['format-json']).toBeUndefined();
    });

    it('serializes textarea inputs correctly', () => {
      const userDir = path.join(tmpDir, 'user');
      const repo = new ScriptRepository({
        userPath: userDir,
        privatePath: '',
        workspaceRoot: '',
      });
      repo.save({
        name: 'S',
        description: '',
        type: 'apex',
        script: 'System.debug();',
        folder: 'cat',
        inputs: [{ name: 'items', type: 'textarea', required: true }],
      });
      const content = fs.readFileSync(path.join(userDir, 'cat', 's.yaml'), 'utf8');
      const doc = yaml.load(content) as Record<string, unknown>;
      expect(doc.inputs).toEqual([{ name: 'items', type: 'textarea', required: true }]);
    });
  });
});

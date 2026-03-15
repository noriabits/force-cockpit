import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { YamlScriptsService } from './YamlScriptsService';
import type { ConnectionManager } from '../../../salesforce/connection';

function makeMock(): ConnectionManager {
  return {
    executeAnonymousWithDebugLog: vi.fn(),
    query: vi.fn(),
    getConnection: vi.fn().mockReturnValue(null),
    getCurrentOrg: vi.fn().mockReturnValue(null),
  } as unknown as ConnectionManager;
}

function makeService(
  paths: Partial<{
    builtInPath: string;
    userPath: string;
    privatePath: string;
    workspaceRoot: string;
  }> = {},
): YamlScriptsService {
  return new YamlScriptsService(makeMock(), {
    builtInPath: paths.builtInPath ?? '',
    userPath: paths.userPath ?? '',
    privatePath: paths.privatePath ?? '',
    workspaceRoot: paths.workspaceRoot ?? '',
  });
}

function writeScript(baseDir: string, folder: string, name: string, content: string): void {
  const dir = path.join(baseDir, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content, 'utf8');
}

describe('YamlScriptsService', () => {
  // ─── Private utility methods ────────────────────────────────────────────────

  describe('toSlug (private)', () => {
    const svc = makeService();

    it('converts name to kebab-case', () => {
      expect((svc as any).toSlug('My Script Name')).toBe('my-script-name');
    });

    it('replaces multiple special characters with a single hyphen', () => {
      expect((svc as any).toSlug('Hello  World!!')).toBe('hello-world');
    });

    it('strips leading and trailing hyphens', () => {
      expect((svc as any).toSlug('  ---name---  ')).toBe('name');
    });

    it('falls back to "script" for an empty result', () => {
      expect((svc as any).toSlug('!!!!')).toBe('script');
    });
  });

  describe('escapeForType (private)', () => {
    const svc = makeService();

    it('apex: doubles single quotes', () => {
      expect((svc as any).escapeForType("it's a test", 'apex')).toBe("it''s a test");
    });

    it('apex: escapes backslashes', () => {
      expect((svc as any).escapeForType('C:\\path', 'apex')).toBe('C:\\\\path');
    });

    it('js: produces JSON-safe escaping (escapes double quotes)', () => {
      const result: string = (svc as any).escapeForType('"quoted"', 'js');
      expect(result).toBe('\\"quoted\\"');
    });

    it('command: returns the raw value unchanged', () => {
      expect((svc as any).escapeForType("raw'value", 'command')).toBe("raw'value");
    });
  });

  describe('substituteInputs (private)', () => {
    const svc = makeService();

    it('replaces ${varName} with the escaped value', () => {
      const script = {
        inputs: [{ name: 'orderId' }],
        type: 'apex',
        script: "Id x = '${orderId}';",
      } as any;
      const result: string = (svc as any).substituteInputs(script, { orderId: 'ord001' });
      expect(result).toBe("Id x = 'ord001';");
    });

    it('replaces an unset optional input with an empty string', () => {
      const script = { inputs: [{ name: 'ext' }], type: 'apex', script: "'${ext}'" } as any;
      const result: string = (svc as any).substituteInputs(script, {});
      expect(result).toBe("''");
    });

    it('returns the script unchanged when there are no inputs', () => {
      const script = { inputs: [], type: 'apex', script: 'SELECT Id FROM Account' } as any;
      const result: string = (svc as any).substituteInputs(script, {});
      expect(result).toBe('SELECT Id FROM Account');
    });

    it('handles regex-special characters in input names', () => {
      const script = {
        inputs: [{ name: 'a.b' }],
        type: 'command',
        script: 'echo ${a.b}',
      } as any;
      const result: string = (svc as any).substituteInputs(script, { 'a.b': 'hello' });
      expect(result).toBe('echo hello');
    });
  });

  describe('parseInputs (private)', () => {
    const svc = makeService();

    it('returns an empty array for undefined input', () => {
      expect((svc as any).parseInputs(undefined)).toEqual([]);
    });

    it('filters out entries that have no name', () => {
      const result = (svc as any).parseInputs([{ label: 'No name here' }]);
      expect(result).toEqual([]);
    });

    it('parses a string input with a custom label', () => {
      const result = (svc as any).parseInputs([{ name: 'orderId', label: 'Order ID' }]);
      expect(result).toEqual([{ name: 'orderId', label: 'Order ID' }]);
    });

    it('parses a picklist input with options', () => {
      const result = (svc as any).parseInputs([
        { name: 'status', type: 'picklist', options: ['New', 'Done'], required: true },
      ]);
      expect(result).toEqual([
        { name: 'status', type: 'picklist', options: ['New', 'Done'], required: true },
      ]);
    });

    it('does not set required unless explicitly true', () => {
      const result = (svc as any).parseInputs([{ name: 'x', required: false }]);
      expect(result[0].required).toBeUndefined();
    });

    it('filters out non-object entries', () => {
      const result = (svc as any).parseInputs(['not-an-object', 42, null]);
      expect(result).toEqual([]);
    });
  });

  // ─── loadScripts — integration with real temp filesystem ──────────────────

  describe('loadScripts', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'force-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns an empty array when both paths do not exist', async () => {
      const svc = makeService({ builtInPath: '/nonexistent/a', userPath: '/nonexistent/b' });
      const scripts = await svc.loadScripts();
      expect(scripts).toEqual([]);
    });

    it('loads a valid apex script from the user path', async () => {
      writeScript(tmpDir, 'orders', 'my-script.yaml', `name: My Script\napex: System.debug('hi');`);
      const svc = makeService({ userPath: tmpDir });
      const scripts = await svc.loadScripts();
      expect(scripts).toHaveLength(1);
      expect(scripts[0]).toMatchObject({ name: 'My Script', type: 'apex', source: 'user' });
    });

    it('loads a command script', async () => {
      writeScript(tmpDir, 'utils', 'cmd.yaml', `name: Run Build\ncommand: npm run build`);
      const svc = makeService({ userPath: tmpDir });
      const scripts = await svc.loadScripts();
      expect(scripts[0]).toMatchObject({ type: 'command', script: 'npm run build' });
    });

    it('loads a js script', async () => {
      writeScript(tmpDir, 'utils', 'js-test.yaml', `name: JS Test\njs: log('hello');`);
      const svc = makeService({ userPath: tmpDir });
      const scripts = await svc.loadScripts();
      expect(scripts[0]).toMatchObject({ type: 'js', script: "log('hello');" });
    });

    it('sorts scripts alphabetically by name', async () => {
      writeScript(tmpDir, 'cat', 'b.yaml', `name: Bravo\napex: '1'`);
      writeScript(tmpDir, 'cat', 'a.yaml', `name: Alpha\napex: '2'`);
      const svc = makeService({ userPath: tmpDir });
      const scripts = await svc.loadScripts();
      expect(scripts.map((s) => s.name)).toEqual(['Alpha', 'Bravo']);
    });

    it('user scripts override built-in scripts with the same id', async () => {
      const builtInDir = path.join(tmpDir, 'builtin');
      const userDir = path.join(tmpDir, 'user');
      writeScript(builtInDir, 'utils', 'my-script.yaml', `name: Built-In\napex: builtIn()`);
      writeScript(userDir, 'utils', 'my-script.yaml', `name: User Override\napex: userVersion()`);

      const svc = makeService({ builtInPath: builtInDir, userPath: userDir });
      const scripts = await svc.loadScripts();

      expect(scripts).toHaveLength(1);
      expect(scripts[0].name).toBe('User Override');
      expect(scripts[0].source).toBe('user');
    });

    it('marks a file with invalid YAML as invalid with a descriptive error', async () => {
      writeScript(tmpDir, 'cat', 'bad.yaml', `: invalid: yaml: [`);
      const svc = makeService({ userPath: tmpDir });
      const scripts = await svc.loadScripts();
      expect(scripts[0].invalid).toBe(true);
      expect(scripts[0].error).toMatch(/Invalid YAML/i);
    });

    it('marks a script without a name field as invalid', async () => {
      writeScript(tmpDir, 'cat', 'no-name.yaml', `apex: System.debug('hi');`);
      const svc = makeService({ userPath: tmpDir });
      const scripts = await svc.loadScripts();
      expect(scripts[0].invalid).toBe(true);
      expect(scripts[0].error).toContain("'name'");
    });

    it('marks a script without any script field as invalid', async () => {
      writeScript(tmpDir, 'cat', 'no-script.yaml', `name: Missing Body`);
      const svc = makeService({ userPath: tmpDir });
      const scripts = await svc.loadScripts();
      expect(scripts[0].invalid).toBe(true);
      expect(scripts[0].error).toContain('apex');
    });

    it('marks a script with multiple script fields as invalid (ambiguous)', async () => {
      writeScript(tmpDir, 'cat', 'ambiguous.yaml', `name: Ambiguous\napex: '1'\ncommand: echo hi`);
      const svc = makeService({ userPath: tmpDir });
      const scripts = await svc.loadScripts();
      expect(scripts[0].invalid).toBe(true);
      expect(scripts[0].error).toContain('Ambiguous');
    });

    it('marks a file-based script as invalid when the referenced file does not exist', async () => {
      writeScript(tmpDir, 'cat', 'missing-file.yaml', `name: Missing\napex-file: nonexistent.cls`);
      const svc = makeService({ userPath: tmpDir, workspaceRoot: tmpDir });
      const scripts = await svc.loadScripts();
      expect(scripts[0].invalid).toBe(true);
      expect(scripts[0].error).toContain('not found');
    });

    it('loads a file-based script when the referenced file exists', async () => {
      const apexFile = path.join(tmpDir, 'my-apex.cls');
      fs.writeFileSync(apexFile, "System.debug('from file');", 'utf8');
      writeScript(tmpDir, 'cat', 'file-script.yaml', `name: File Script\napex-file: my-apex.cls`);
      const svc = makeService({ userPath: tmpDir, workspaceRoot: tmpDir });
      const scripts = await svc.loadScripts();
      expect(scripts[0].invalid).toBeUndefined();
      expect(scripts[0].script).toContain('from file');
    });

    it('three-way merge: private overrides user overrides builtin', async () => {
      const builtInDir = path.join(tmpDir, 'builtin');
      const userDir = path.join(tmpDir, 'user');
      const privateDir = path.join(tmpDir, 'private');

      writeScript(builtInDir, 'cat', 'shared.yaml', `name: BuiltIn Version\napex: builtin()`);
      writeScript(userDir, 'cat', 'shared.yaml', `name: User Version\napex: user()`);
      writeScript(privateDir, 'cat', 'shared.yaml', `name: Private Version\napex: private()`);

      const svc = makeService({
        builtInPath: builtInDir,
        userPath: userDir,
        privatePath: privateDir,
      });
      const scripts = await svc.loadScripts();

      expect(scripts).toHaveLength(1);
      expect(scripts[0].name).toBe('Private Version');
      expect(scripts[0].source).toBe('private');
    });

    it('three-way merge: private does not affect other ids', async () => {
      const userDir = path.join(tmpDir, 'user');
      const privateDir = path.join(tmpDir, 'private');

      writeScript(userDir, 'cat', 'shared-script.yaml', `name: Shared Script\napex: shared()`);
      writeScript(
        privateDir,
        'cat',
        'private-script.yaml',
        `name: Private Script\napex: private()`,
      );

      const svc = makeService({ userPath: userDir, privatePath: privateDir });
      const scripts = await svc.loadScripts();

      expect(scripts).toHaveLength(2);
      const names = scripts.map((s) => s.name).sort();
      expect(names).toEqual(['Private Script', 'Shared Script']);
      expect(scripts.find((s) => s.name === 'Private Script')?.source).toBe('private');
      expect(scripts.find((s) => s.name === 'Shared Script')?.source).toBe('user');
    });

    it('loads scripts from sub-folders (2-level nesting)', async () => {
      writeScript(
        tmpDir,
        path.join('orders', 'advanced'),
        'deep-script.yaml',
        `name: Deep Script\napex: deep()`,
      );
      const svc = makeService({ userPath: tmpDir });
      const scripts = await svc.loadScripts();

      expect(scripts).toHaveLength(1);
      expect(scripts[0].folder).toBe('orders/advanced');
      expect(scripts[0].id).toBe('orders/advanced/deep-script');
    });
  });

  describe('saveScript / deleteScript (private flag)', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'force-save-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('saves a shared script to userPath', async () => {
      const userDir = path.join(tmpDir, 'user');
      const svc = makeService({ userPath: userDir });

      const saved = svc.saveScript(
        {
          name: 'My Script',
          description: '',
          type: 'apex',
          script: "System.debug('x');",
          folder: 'cat',
          inputs: [],
        },
        false,
      );

      expect(saved.source).toBe('user');
      expect(fs.existsSync(path.join(userDir, 'cat', 'my-script.yaml'))).toBe(true);
    });

    it('saves a private script to privatePath', async () => {
      const privateDir = path.join(tmpDir, 'private');
      const svc = makeService({ userPath: path.join(tmpDir, 'user'), privatePath: privateDir });

      const saved = svc.saveScript(
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

    it('throws when saving a private script that conflicts with a shared one', async () => {
      const userDir = path.join(tmpDir, 'user');
      const privateDir = path.join(tmpDir, 'private');

      // Write a shared script
      writeScript(userDir, 'cat', 'my-script.yaml', `name: My Script\napex: shared()`);

      const svc = makeService({ userPath: userDir, privatePath: privateDir });

      expect(() =>
        svc.saveScript(
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

    it('throws when saving a shared script that conflicts with a private one', async () => {
      const userDir = path.join(tmpDir, 'user');
      const privateDir = path.join(tmpDir, 'private');

      // Write a private script
      writeScript(privateDir, 'cat', 'my-script.yaml', `name: My Script\napex: private()`);

      const svc = makeService({ userPath: userDir, privatePath: privateDir });

      expect(() =>
        svc.saveScript(
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

    it('deletes a script from privatePath when isPrivate=true', async () => {
      const privateDir = path.join(tmpDir, 'private');
      writeScript(privateDir, 'cat', 'my-script.yaml', `name: My Script\napex: private()`);

      const svc = makeService({ userPath: path.join(tmpDir, 'user'), privatePath: privateDir });
      svc.deleteScript('cat/my-script', true);

      expect(fs.existsSync(path.join(privateDir, 'cat', 'my-script.yaml'))).toBe(false);
    });

    it('moves script from userPath to privatePath on update when privacy changes', async () => {
      const userDir = path.join(tmpDir, 'user');
      const privateDir = path.join(tmpDir, 'private');

      writeScript(userDir, 'cat', 'my-script.yaml', `name: My Script\napex: shared()`);

      const svc = makeService({ userPath: userDir, privatePath: privateDir });

      svc.updateScript(
        'cat/my-script',
        {
          name: 'My Script',
          description: '',
          type: 'apex',
          script: 'private()',
          folder: 'cat',
          inputs: [],
        },
        true, // isPrivate (new)
        false, // wasPrivate (old)
      );

      expect(fs.existsSync(path.join(userDir, 'cat', 'my-script.yaml'))).toBe(false);
      expect(fs.existsSync(path.join(privateDir, 'cat', 'my-script.yaml'))).toBe(true);
    });
  });
});

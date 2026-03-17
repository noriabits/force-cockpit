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

    it('apex: escapes LF newlines as \\n', () => {
      expect((svc as any).escapeForType('line1\nline2', 'apex')).toBe('line1\\nline2');
    });

    it('apex: escapes CRLF newlines as \\n', () => {
      expect((svc as any).escapeForType('line1\r\nline2', 'apex')).toBe('line1\\nline2');
    });

    it('apex: escapes CR newlines as \\n', () => {
      expect((svc as any).escapeForType('line1\rline2', 'apex')).toBe('line1\\nline2');
    });

    it('js: escapes newlines via JSON (\\n → \\\\n in output)', () => {
      // JSON.stringify('a\nb') = '"a\\nb"' → slice gives 'a\\nb'
      const result: string = (svc as any).escapeForType('a\nb', 'js');
      expect(result).toBe('a\\nb');
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

    it('substitutes a textarea value with newlines into an Apex string (newlines escaped)', () => {
      const script = {
        inputs: [{ name: 'items', type: 'textarea' }],
        type: 'apex',
        script: "String s = '${items}';",
      } as any;
      const result: string = (svc as any).substituteInputs(script, { items: 'a\nb\nc' });
      expect(result).toBe("String s = 'a\\nb\\nc';");
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

  describe('substituteSystemPlaceholders (private)', () => {
    it('replaces ${orgUsername} with the connected org username', () => {
      const mock = makeMock();
      (mock.getCurrentOrg as ReturnType<typeof vi.fn>).mockReturnValue({
        username: 'admin@myorg.com',
      });
      const svc = new YamlScriptsService(mock, {
        builtInPath: '',
        userPath: '',
        privatePath: '',
        workspaceRoot: '',
      });
      const result: string = (svc as any).substituteSystemPlaceholders(
        "String u = '${orgUsername}';",
        'apex',
      );
      expect(result).toBe("String u = 'admin@myorg.com';");
    });

    it('applies Apex escaping to the username', () => {
      const mock = makeMock();
      (mock.getCurrentOrg as ReturnType<typeof vi.fn>).mockReturnValue({
        username: "it's@org.com",
      });
      const svc = new YamlScriptsService(mock, {
        builtInPath: '',
        userPath: '',
        privatePath: '',
        workspaceRoot: '',
      });
      const result: string = (svc as any).substituteSystemPlaceholders(
        "'${orgUsername}'",
        'apex',
      );
      expect(result).toBe("'it''s@org.com'");
    });

    it('applies JS escaping to the username', () => {
      const mock = makeMock();
      (mock.getCurrentOrg as ReturnType<typeof vi.fn>).mockReturnValue({
        username: 'user"name@org.com',
      });
      const svc = new YamlScriptsService(mock, {
        builtInPath: '',
        userPath: '',
        privatePath: '',
        workspaceRoot: '',
      });
      const result: string = (svc as any).substituteSystemPlaceholders(
        '"${orgUsername}"',
        'js',
      );
      expect(result).toBe('"user\\"name@org.com"');
    });

    it('resolves to empty string when no org is connected', () => {
      const svc = makeService();
      const result: string = (svc as any).substituteSystemPlaceholders(
        'echo ${orgUsername}',
        'command',
      );
      expect(result).toBe('echo ');
    });

    it('replaces multiple occurrences', () => {
      const mock = makeMock();
      (mock.getCurrentOrg as ReturnType<typeof vi.fn>).mockReturnValue({
        username: 'admin@myorg.com',
      });
      const svc = new YamlScriptsService(mock, {
        builtInPath: '',
        userPath: '',
        privatePath: '',
        workspaceRoot: '',
      });
      const result: string = (svc as any).substituteSystemPlaceholders(
        '${orgUsername} and ${orgUsername}',
        'command',
      );
      expect(result).toBe('admin@myorg.com and admin@myorg.com');
    });

    it('leaves content unchanged when no system placeholders are present', () => {
      const svc = makeService();
      const result: string = (svc as any).substituteSystemPlaceholders(
        "System.debug('hello');",
        'apex',
      );
      expect(result).toBe("System.debug('hello');");
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

    it('parses a textarea input', () => {
      const result = (svc as any).parseInputs([{ name: 'itemList', type: 'textarea', required: true }]);
      expect(result).toEqual([{ name: 'itemList', type: 'textarea', required: true }]);
    });
  });

  describe('serializeInputs (private)', () => {
    const svc = makeService();

    it('returns undefined for empty inputs', () => {
      expect((svc as any).serializeInputs([])).toBeUndefined();
    });

    it('serializes a textarea input', () => {
      const result = (svc as any).serializeInputs([{ name: 'itemList', type: 'textarea' }]);
      expect(result).toEqual([{ name: 'itemList', type: 'textarea' }]);
    });

    it('omits type for string inputs (implied default)', () => {
      const result = (svc as any).serializeInputs([{ name: 'x' }]);
      expect(result).toEqual([{ name: 'x' }]);
    });

    it('serializes textarea input with required flag', () => {
      const result = (svc as any).serializeInputs([{ name: 'items', type: 'textarea', required: true }]);
      expect(result).toEqual([{ name: 'items', type: 'textarea', required: true }]);
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

  // ─── New helper unit tests ──────────────────────────────────────────────────

  describe('makeInvalidScript (private)', () => {
    const svc = makeService();

    it('sets invalid:true and the given error', () => {
      const result = (svc as any).makeInvalidScript(
        { id: 'cat/s', folder: 'cat', name: 'S', description: '', source: 'user' },
        'bad stuff',
      );
      expect(result.invalid).toBe(true);
      expect(result.error).toBe('bad stuff');
    });

    it('defaults type to apex when not supplied', () => {
      const result = (svc as any).makeInvalidScript(
        { id: 'cat/s', folder: 'cat', name: 'S', description: '', source: 'user' },
        'err',
      );
      expect(result.type).toBe('apex');
    });

    it('uses the supplied type when provided', () => {
      const result = (svc as any).makeInvalidScript(
        { id: 'cat/s', folder: 'cat', name: 'S', description: '', source: 'user', type: 'js' },
        'err',
      );
      expect(result.type).toBe('js');
    });

    it('omits inputs when the array is empty', () => {
      const result = (svc as any).makeInvalidScript(
        { id: 'cat/s', folder: 'cat', name: 'S', description: '', source: 'user', inputs: [] },
        'err',
      );
      expect(result.inputs).toBeUndefined();
    });

    it('includes inputs when the array is non-empty', () => {
      const inputs = [{ name: 'x' }];
      const result = (svc as any).makeInvalidScript(
        { id: 'cat/s', folder: 'cat', name: 'S', description: '', source: 'user', inputs },
        'err',
      );
      expect(result.inputs).toEqual(inputs);
    });

    it('omits scriptFile when falsy', () => {
      const result = (svc as any).makeInvalidScript(
        { id: 'cat/s', folder: 'cat', name: 'S', description: '', source: 'user', scriptFile: undefined },
        'err',
      );
      expect(result.scriptFile).toBeUndefined();
    });

    it('includes scriptFile when provided', () => {
      const result = (svc as any).makeInvalidScript(
        { id: 'cat/s', folder: 'cat', name: 'S', description: '', source: 'user', scriptFile: 'my.cls' },
        'err',
      );
      expect(result.scriptFile).toBe('my.cls');
    });
  });

  describe('detectScriptKind (private)', () => {
    const svc = makeService();

    it('inline apex → type apex, isFileRef false', () => {
      const result = (svc as any).detectScriptKind({ apex: 'System.debug();' });
      expect(result).toEqual({ type: 'apex', isFileRef: false, scriptFile: undefined });
    });

    it('inline js → type js, isFileRef false', () => {
      const result = (svc as any).detectScriptKind({ js: 'log(1);' });
      expect(result).toEqual({ type: 'js', isFileRef: false, scriptFile: undefined });
    });

    it('inline command → type command, isFileRef false', () => {
      const result = (svc as any).detectScriptKind({ command: 'npm test' });
      expect(result).toEqual({ type: 'command', isFileRef: false, scriptFile: undefined });
    });

    it('apex-file → type apex, isFileRef true, scriptFile set', () => {
      const result = (svc as any).detectScriptKind({ 'apex-file': 'my.cls' });
      expect(result).toEqual({ type: 'apex', isFileRef: true, scriptFile: 'my.cls' });
    });

    it('js-file → type js, isFileRef true, scriptFile set', () => {
      const result = (svc as any).detectScriptKind({ 'js-file': 'my.js' });
      expect(result).toEqual({ type: 'js', isFileRef: true, scriptFile: 'my.js' });
    });

    it('command-file → type command, isFileRef true, scriptFile set', () => {
      const result = (svc as any).detectScriptKind({ 'command-file': 'run.sh' });
      expect(result).toEqual({ type: 'command', isFileRef: true, scriptFile: 'run.sh' });
    });
  });

  describe('validateYamlDoc (private)', () => {
    const svc = makeService();
    const base = { id: 'cat/s', folder: 'cat', source: 'user' as const };

    it('returns null for a valid doc', () => {
      const result = (svc as any).validateYamlDoc(
        { name: 'S', apex: 'x' },
        base.id, base.folder, base.source, [],
      );
      expect(result).toBeNull();
    });

    it('returns invalid script when name is missing', () => {
      const result = (svc as any).validateYamlDoc(
        { apex: 'x' },
        base.id, base.folder, base.source, [],
      );
      expect(result?.invalid).toBe(true);
      expect(result?.error).toContain("'name'");
    });

    it('returns invalid script when multiple script fields are set', () => {
      const result = (svc as any).validateYamlDoc(
        { name: 'S', apex: 'x', command: 'y' },
        base.id, base.folder, base.source, [],
      );
      expect(result?.invalid).toBe(true);
      expect(result?.error).toContain('Ambiguous');
    });

    it('returns invalid script when no script field is present', () => {
      const result = (svc as any).validateYamlDoc(
        { name: 'S' },
        base.id, base.folder, base.source, [],
      );
      expect(result?.invalid).toBe(true);
      expect(result?.error).toContain('apex');
    });
  });

  describe('resolveScriptContent (private)', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'force-resolve-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const base = { id: 'cat/s', folder: 'cat', source: 'user' as const };

    it('returns content directly for an inline script', () => {
      const svc = makeService();
      const result = (svc as any).resolveScriptContent(
        { apex: 'System.debug();' }, base.id, base.folder, base.source, [], 'apex', undefined,
      );
      expect(result).toEqual({ content: 'System.debug();' });
    });

    it('returns invalid when workspaceRoot is empty and scriptFile is set', () => {
      const svc = makeService({ workspaceRoot: '' });
      const result = (svc as any).resolveScriptContent(
        { name: 'S', description: '' }, base.id, base.folder, base.source, [], 'apex', 'my.cls',
      );
      expect(result.invalid?.invalid).toBe(true);
      expect(result.invalid?.error).toContain('no workspace folder');
    });

    it('returns invalid when scriptFile is outside the workspace', () => {
      const svc = makeService({ workspaceRoot: tmpDir });
      const result = (svc as any).resolveScriptContent(
        { name: 'S', description: '' }, base.id, base.folder, base.source, [], 'apex', '../outside.cls',
      );
      expect(result.invalid?.invalid).toBe(true);
      expect(result.invalid?.error).toContain('inside the workspace');
    });

    it('returns invalid when scriptFile does not exist', () => {
      const svc = makeService({ workspaceRoot: tmpDir });
      const result = (svc as any).resolveScriptContent(
        { name: 'S', description: '' }, base.id, base.folder, base.source, [], 'apex', 'missing.cls',
      );
      expect(result.invalid?.invalid).toBe(true);
      expect(result.invalid?.error).toContain('not found');
    });

    it('returns content when scriptFile exists inside workspace', () => {
      fs.writeFileSync(path.join(tmpDir, 'my.cls'), 'System.debug();', 'utf8');
      const svc = makeService({ workspaceRoot: tmpDir });
      const result = (svc as any).resolveScriptContent(
        { name: 'S', description: '' }, base.id, base.folder, base.source, [], 'apex', 'my.cls',
      );
      expect(result).toEqual({ content: 'System.debug();' });
    });
  });
});

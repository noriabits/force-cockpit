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

describe('YamlScriptsService — loadScripts integration', () => {
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
    writeScript(privateDir, 'cat', 'private-script.yaml', `name: Private Script\napex: private()`);

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

describe('YamlScriptsService — filterUserDebug / formatJson flags', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-defaults-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses filter-user-debug:true on apex script', async () => {
    writeScript(
      tmpDir,
      'cat',
      's.yaml',
      'name: S\napex: System.debug();\nfilter-user-debug: true\n',
    );
    const svc = makeService({ userPath: tmpDir });
    const scripts = await svc.loadScripts();
    expect(scripts[0].filterUserDebug).toBe(true);
    expect(scripts[0].formatJson).toBeUndefined();
  });

  it('parses format-json:true on apex script', async () => {
    writeScript(tmpDir, 'cat', 's.yaml', 'name: S\napex: System.debug();\nformat-json: true\n');
    const svc = makeService({ userPath: tmpDir });
    const scripts = await svc.loadScripts();
    expect(scripts[0].formatJson).toBe(true);
    expect(scripts[0].filterUserDebug).toBeUndefined();
  });

  it('parses both flags together on apex script', async () => {
    writeScript(
      tmpDir,
      'cat',
      's.yaml',
      'name: S\napex: System.debug();\nfilter-user-debug: true\nformat-json: true\n',
    );
    const svc = makeService({ userPath: tmpDir });
    const scripts = await svc.loadScripts();
    expect(scripts[0].filterUserDebug).toBe(true);
    expect(scripts[0].formatJson).toBe(true);
  });

  it('leaves both fields undefined when absent', async () => {
    writeScript(tmpDir, 'cat', 's.yaml', 'name: S\napex: System.debug();\n');
    const svc = makeService({ userPath: tmpDir });
    const scripts = await svc.loadScripts();
    expect(scripts[0].filterUserDebug).toBeUndefined();
    expect(scripts[0].formatJson).toBeUndefined();
  });

  it('ignores filter-user-debug on command script', async () => {
    writeScript(tmpDir, 'cat', 's.yaml', 'name: S\ncommand: echo hi\nfilter-user-debug: true\n');
    const svc = makeService({ userPath: tmpDir });
    const scripts = await svc.loadScripts();
    expect(scripts[0].filterUserDebug).toBeUndefined();
  });

  it('ignores format-json on js script', async () => {
    writeScript(tmpDir, 'cat', 's.yaml', "name: S\njs: log('hi');\nformat-json: true\n");
    const svc = makeService({ userPath: tmpDir });
    const scripts = await svc.loadScripts();
    expect(scripts[0].formatJson).toBeUndefined();
  });
});

describe('YamlScriptsService — executeScript orchestration', () => {
  it('returns a not-found result when script id is unknown', async () => {
    const svc = makeService();
    const result = await svc.executeScript('missing', [], {});
    expect(result.success).toBe(false);
    expect(result.message).toContain('not found');
  });

  it('fails early when a required input is missing', async () => {
    const svc = makeService();
    const scripts = [
      {
        id: 'cat/s',
        folder: 'cat',
        name: 'S',
        description: '',
        type: 'apex' as const,
        script: "System.debug('${x}');",
        source: 'user' as const,
        inputs: [{ name: 'x', required: true, label: 'X value' }],
      },
    ];
    const result = await svc.executeScript('cat/s', scripts, {});
    expect(result.success).toBe(false);
    expect(result.message).toContain('X value');
  });

  it('substitutes inputs and calls executeAnonymousWithDebugLog for apex scripts', async () => {
    const mock = makeMock();
    (mock.executeAnonymousWithDebugLog as ReturnType<typeof vi.fn>).mockResolvedValue({
      compiled: true,
      success: true,
      debugLog: 'log-output',
    });
    const svc = new YamlScriptsService(mock, {
      builtInPath: '',
      userPath: '',
      privatePath: '',
      workspaceRoot: '',
    });
    const scripts = [
      {
        id: 'cat/s',
        folder: 'cat',
        name: 'S',
        description: '',
        type: 'apex' as const,
        script: "System.debug('${x}');",
        source: 'user' as const,
        inputs: [{ name: 'x' }],
      },
    ];
    const result = await svc.executeScript('cat/s', scripts, { x: 'value' });

    expect(result.success).toBe(true);
    expect(mock.executeAnonymousWithDebugLog).toHaveBeenCalledWith(
      "System.debug('value');",
      expect.objectContaining({ logLevels: { Apex_code: 'DEBUG' } }),
    );
  });
});

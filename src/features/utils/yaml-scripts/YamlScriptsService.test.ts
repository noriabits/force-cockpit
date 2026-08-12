import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { YamlScriptsService } from './YamlScriptsService';
import type { YamlScript } from './types';
import type { ConnectionManager } from '../../../salesforce/connection';
import { DescribeService } from '../../../services/describe/DescribeService';
import type { LmGateway } from '../../../services/ai/types';
import { SkillsRepository } from '../../../services/skills/SkillsRepository';

// These tests never execute AI scripts, so a memory-only DescribeService suffices.
function makeDescribe(cm: ConnectionManager): DescribeService {
  return new DescribeService(cm);
}

// These tests never execute AI scripts, so an empty skills repo suffices.
function makeSkills(): SkillsRepository {
  return new SkillsRepository('', []);
}

function makeMock(): ConnectionManager {
  return {
    executeAnonymousWithDebugLog: vi.fn(),
    query: vi.fn(),
    getConnection: vi.fn().mockReturnValue(null),
    getCurrentOrg: vi.fn().mockReturnValue(null),
  } as unknown as ConnectionManager;
}

// These tests never execute AI scripts, so a no-op gateway suffices.
function makeGateway(): LmGateway {
  return {
    listModels: async () => [],
    send: async function* () {},
  };
}

function makeService(
  paths: Partial<{
    builtInPath: string;
    userPath: string;
    privatePath: string;
    workspaceRoot: string;
  }> = {},
): YamlScriptsService {
  const cm = makeMock();
  return new YamlScriptsService(
    cm,
    {
      builtInPath: paths.builtInPath ?? '',
      userPath: paths.userPath ?? '',
      privatePath: paths.privatePath ?? '',
      workspaceRoot: paths.workspaceRoot ?? '',
    },
    makeGateway(),
    makeSkills(),
    makeDescribe(cm),
  );
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
    const svc = new YamlScriptsService(
      mock,
      {
        builtInPath: '',
        userPath: '',
        privatePath: '',
        workspaceRoot: '',
      },
      makeGateway(),
      makeSkills(),
      makeDescribe(mock),
    );
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
      expect.objectContaining({
        logLevels: expect.objectContaining({ Apex_code: 'DEBUG', Db: 'NONE' }),
      }),
    );
  });
});

describe('YamlScriptsService — script composition', () => {
  function script(
    over: Partial<YamlScript> & Pick<YamlScript, 'id' | 'type' | 'script'>,
  ): YamlScript {
    return {
      folder: 'cat',
      name: over.id,
      description: '',
      source: 'user',
      ...over,
    } as YamlScript;
  }

  /** Service whose apex runs echo a `::fc-output` marker built from the body. */
  function makeApexEchoService(debugLogFor: (body: string) => string) {
    const mock = makeMock();
    (mock.executeAnonymousWithDebugLog as ReturnType<typeof vi.fn>).mockImplementation(
      async (body: string) => ({
        compiled: true,
        success: true,
        debugLog: debugLogFor(body),
      }),
    );
    const svc = new YamlScriptsService(
      mock,
      { builtInPath: '', userPath: '', privatePath: '', workspaceRoot: '' },
      makeGateway(),
      makeSkills(),
      makeDescribe(mock),
    );
    return { svc, mock };
  }

  it('passes a value from an apex child to its js caller via ::fc-output', async () => {
    const { svc, mock } = makeApexEchoService(
      () => '12:00:00.0 (1)|USER_DEBUG|[1]|DEBUG|::fc-output accountId=001xx0000000001',
    );
    const scripts = [
      script({
        id: 'cat/parent',
        type: 'js',
        script: `
          const r = await runScript('cat/child', { accountName: 'Acme' });
          setOutput('captured', r.outputs.accountId);
          log('child gave ' + r.outputs.accountId);
        `,
      }),
      script({
        id: 'cat/child',
        type: 'apex',
        script: "System.debug('${accountName}');",
        // Declared exactly as it would be to run from the UI — a called script
        // only substitutes inputs it declares.
        inputs: [{ name: 'accountName' }],
      }),
    ];

    const result = await svc.executeScript('cat/parent', scripts, {});

    expect(result.success).toBe(true);
    expect(result.outputs).toEqual({ captured: '001xx0000000001' });
    expect(result.debugLog).toContain('child gave 001xx0000000001');
    // The child ran with the inputs the parent supplied.
    expect(mock.executeAnonymousWithDebugLog).toHaveBeenCalledWith(
      "System.debug('Acme');",
      expect.anything(),
    );
  });

  it("does not adopt a child's outputs as the caller's own", async () => {
    const { svc } = makeApexEchoService(
      () => '12:00:00.0 (1)|USER_DEBUG|[1]|DEBUG|::fc-output secret=child-only',
    );
    const scripts = [
      script({ id: 'cat/parent', type: 'js', script: `await runScript('cat/child');` }),
      script({ id: 'cat/child', type: 'apex', script: 'System.debug(1);' }),
    ];

    const result = await svc.executeScript('cat/parent', scripts, {});

    // The marker is visible in the log, but the parent must re-export it via
    // setOutput() to claim it.
    expect(result.debugLog).toContain('::fc-output secret=child-only');
    expect(result.outputs).toEqual({});
  });

  it("includes the child's header and log in the parent's debugLog", async () => {
    const { svc } = makeApexEchoService(
      () => '12:00:00.0 (1)|USER_DEBUG|[1]|DEBUG|hello from the child',
    );
    const scripts = [
      script({ id: 'cat/parent', type: 'js', script: `await runScript('cat/child');` }),
      script({ id: 'cat/child', type: 'apex', script: 'System.debug(1);' }),
    ];

    const result = await svc.executeScript('cat/parent', scripts, {});

    expect(result.debugLog).toContain('── ▶ cat/child ──');
    expect(result.debugLog).toContain('hello from the child');
  });

  it('rejects by default when a child fails, and resolves with throwOnError: false', async () => {
    const mock = makeMock();
    (mock.executeAnonymousWithDebugLog as ReturnType<typeof vi.fn>).mockResolvedValue({
      compiled: false,
      success: false,
      compileProblem: 'Unexpected token',
    });
    const svc = new YamlScriptsService(
      mock,
      { builtInPath: '', userPath: '', privatePath: '', workspaceRoot: '' },
      makeGateway(),
      makeSkills(),
      makeDescribe(mock),
    );
    const child = script({ id: 'cat/child', type: 'apex', script: 'oops' });

    const thrown = await svc.executeScript(
      'cat/parent',
      [script({ id: 'cat/parent', type: 'js', script: `await runScript('cat/child');` }), child],
      {},
    );
    expect(thrown.success).toBe(false);
    expect(thrown.message).toContain('cat/child');

    const tolerated = await svc.executeScript(
      'cat/parent',
      [
        script({
          id: 'cat/parent',
          type: 'js',
          script: `
            const r = await runScript('cat/child', {}, { throwOnError: false });
            log('survived, success=' + r.success);
          `,
        }),
        child,
      ],
      {},
    );
    expect(tolerated.success).toBe(true);
    expect(tolerated.debugLog).toContain('survived, success=false');
  });

  it('detects a circular script call', async () => {
    const { svc } = makeApexEchoService(() => '');
    const scripts = [
      script({ id: 'cat/a', type: 'js', script: `await runScript('cat/b');` }),
      script({ id: 'cat/b', type: 'js', script: `await runScript('cat/a');` }),
    ];

    const result = await svc.executeScript('cat/a', scripts, {});

    expect(result.success).toBe(false);
    expect(result.message).toContain('Circular script call');
    expect(result.message).toContain('cat/a → cat/b → cat/a');
  });

  it('enforces the chain depth limit for a self-widening chain', async () => {
    const { svc } = makeApexEchoService(() => '');
    // Each link calls the next; 12 links exceeds MAX_CHAIN_DEPTH (10).
    const scripts = Array.from({ length: 12 }, (_, i) =>
      script({ id: `cat/s${i}`, type: 'js', script: `await runScript('cat/s${i + 1}');` }),
    );

    const result = await svc.executeScript('cat/s0', scripts, {});

    expect(result.success).toBe(false);
    expect(result.message).toContain('depth limit');
  });

  it("validates the child's own required inputs", async () => {
    const { svc } = makeApexEchoService(() => '');
    const scripts = [
      script({
        id: 'cat/parent',
        type: 'js',
        script: `
          const r = await runScript('cat/child', {}, { throwOnError: false });
          log('msg: ' + r.message);
        `,
      }),
      script({
        id: 'cat/child',
        type: 'apex',
        script: "System.debug('${needed}');",
        inputs: [{ name: 'needed', required: true, label: 'Needed value' }],
      }),
    ];

    const result = await svc.executeScript('cat/parent', scripts, {});

    expect(result.debugLog).toContain('Needed value');
  });

  it('runs then: steps after an apex body and forwards its ::fc-output values', async () => {
    const { svc, mock } = makeApexEchoService((body) =>
      body.includes('hierarchy')
        ? '12:00:00.0 (1)|USER_DEBUG|[1]|DEBUG|::fc-output contractantAccId=001AAA'
        : '12:00:00.0 (1)|USER_DEBUG|[1]|DEBUG|cart built',
    );
    const scripts = [
      script({
        id: 'cat/parent',
        type: 'apex',
        script: "System.debug('hierarchy ${accountName}');",
        inputs: [{ name: 'accountName' }, { name: 'cartType' }],
        then: [
          {
            script: 'cat/cart',
            with: { accountId: '${contractantAccId}', cartType: '${cartType}' },
          },
        ],
      }),
      script({
        id: 'cat/cart',
        type: 'apex',
        script: "System.debug('cart ${accountId} ${cartType}');",
        inputs: [{ name: 'accountId' }, { name: 'cartType' }],
      }),
    ];

    const result = await svc.executeScript('cat/parent', scripts, {
      accountName: 'Acme',
      cartType: 'Quote',
    });

    expect(result.success).toBe(true);
    expect(mock.executeAnonymousWithDebugLog).toHaveBeenCalledTimes(2);
    // The output of the body reached the follow-up, alongside a plain input.
    expect(mock.executeAnonymousWithDebugLog).toHaveBeenLastCalledWith(
      "System.debug('cart 001AAA Quote');",
      expect.anything(),
    );
    // The follow-up's log is appended to the parent's, under a header.
    expect(result.debugLog).toContain('── ▶ cat/cart ──');
    expect(result.debugLog).toContain('cart built');
    expect(result.filteredDebugLog).toContain('cart built');
  });

  it('does not run then: steps when the body fails', async () => {
    const mock = makeMock();
    (mock.executeAnonymousWithDebugLog as ReturnType<typeof vi.fn>).mockResolvedValue({
      compiled: false,
      success: false,
      compileProblem: 'nope',
    });
    const svc = new YamlScriptsService(
      mock,
      { builtInPath: '', userPath: '', privatePath: '', workspaceRoot: '' },
      makeGateway(),
      makeSkills(),
      makeDescribe(mock),
    );
    const scripts = [
      script({
        id: 'cat/parent',
        type: 'apex',
        script: 'boom',
        then: [{ script: 'cat/cart' }],
      }),
      script({ id: 'cat/cart', type: 'apex', script: 'System.debug(1);' }),
    ];

    const result = await svc.executeScript('cat/parent', scripts, {});

    expect(result.success).toBe(false);
    expect(mock.executeAnonymousWithDebugLog).toHaveBeenCalledTimes(1);
  });

  it('fails the run when a then: step fails, and stops the remaining steps', async () => {
    const mock = makeMock();
    (mock.executeAnonymousWithDebugLog as ReturnType<typeof vi.fn>).mockImplementation(
      async (body: string) =>
        body.includes('ok')
          ? { compiled: true, success: true, debugLog: '' }
          : { compiled: false, success: false, compileProblem: 'bad step' },
    );
    const svc = new YamlScriptsService(
      mock,
      { builtInPath: '', userPath: '', privatePath: '', workspaceRoot: '' },
      makeGateway(),
      makeSkills(),
      makeDescribe(mock),
    );
    const scripts = [
      script({
        id: 'cat/parent',
        type: 'apex',
        script: 'ok body',
        then: [{ script: 'cat/bad' }, { script: 'cat/never' }],
      }),
      script({ id: 'cat/bad', type: 'apex', script: 'explodes' }),
      script({ id: 'cat/never', type: 'apex', script: 'ok never' }),
    ];

    const result = await svc.executeScript('cat/parent', scripts, {});

    expect(result.success).toBe(false);
    expect(result.message).toContain('cat/bad');
    // body + failing step only — the third script never ran.
    expect(mock.executeAnonymousWithDebugLog).toHaveBeenCalledTimes(2);
    expect(result.debugLog).toContain('--- error ---');
  });

  it('runs several then: steps in order', async () => {
    const { svc, mock } = makeApexEchoService(() => '');
    const scripts = [
      script({
        id: 'cat/parent',
        type: 'apex',
        script: 'body',
        then: [{ script: 'cat/one' }, { script: 'cat/two' }],
      }),
      script({ id: 'cat/one', type: 'apex', script: 'first' }),
      script({ id: 'cat/two', type: 'apex', script: 'second' }),
    ];

    await svc.executeScript('cat/parent', scripts, {});

    const bodies = (mock.executeAnonymousWithDebugLog as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0],
    );
    expect(bodies).toEqual(['body', 'first', 'second']);
  });

  it('skips a then: step whose when: is false, and says so in the log', async () => {
    const { svc, mock } = makeApexEchoService(() => '');
    const scripts = [
      script({
        id: 'cat/parent',
        type: 'apex',
        script: 'body',
        inputs: [{ name: 'cartType' }],
        then: [{ script: 'cat/cart', when: '${cartType} !== "None"' }, { script: 'cat/always' }],
      }),
      script({ id: 'cat/cart', type: 'apex', script: 'CART' }),
      script({ id: 'cat/always', type: 'apex', script: 'ALWAYS' }),
    ];

    const skipped = await svc.executeScript('cat/parent', scripts, { cartType: 'None' });
    expect(skipped.success).toBe(true);
    expect(skipped.debugLog).toContain('⏭ cat/cart skipped');
    // The guarded step did not run; the unguarded one still did.
    expect(
      (mock.executeAnonymousWithDebugLog as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]),
    ).toEqual(['body', 'ALWAYS']);
  });

  it('logs the substituted expression on both outcomes, so a guard shows its reason', async () => {
    const scripts = [
      script({
        id: 'cat/parent',
        type: 'apex',
        script: 'body',
        inputs: [{ name: 'cartType' }],
        then: [{ script: 'cat/cart', when: '${cartType} !== "None"' }],
      }),
      script({ id: 'cat/cart', type: 'apex', script: 'CART' }),
    ];

    const ran = await makeApexEchoService(() => '').svc.executeScript('cat/parent', scripts, {
      cartType: 'Quote',
    });
    expect(ran.debugLog).toContain(
      '✔ cat/cart (when: ${cartType} !== "None" → "Quote" !== "None")',
    );

    const skipped = await makeApexEchoService(() => '').svc.executeScript('cat/parent', scripts, {
      cartType: 'None',
    });
    expect(skipped.debugLog).toContain(
      '⏭ cat/cart skipped (when: ${cartType} !== "None" → "None" !== "None")',
    );
  });

  it('shows an empty substitution when the value never arrived', async () => {
    // The failure mode that reads as "the condition was ignored": an unresolved
    // placeholder becomes "", and "" !== "None" passes.
    const { svc } = makeApexEchoService(() => '');
    const scripts = [
      script({
        id: 'cat/parent',
        type: 'apex',
        script: 'body',
        then: [{ script: 'cat/cart', when: '${cartType} !== "None"' }],
      }),
      script({ id: 'cat/cart', type: 'apex', script: 'CART' }),
    ];

    const result = await svc.executeScript('cat/parent', scripts, {});
    expect(result.debugLog).toContain('✔ cat/cart (when: ${cartType} !== "None" → "" !== "None")');
  });

  it('logs nothing extra for a step with no when:', async () => {
    const { svc } = makeApexEchoService(() => '');
    const scripts = [
      script({ id: 'cat/parent', type: 'apex', script: 'body', then: [{ script: 'cat/cart' }] }),
      script({ id: 'cat/cart', type: 'apex', script: 'CART' }),
    ];

    const result = await svc.executeScript('cat/parent', scripts, {});
    expect(result.debugLog).not.toContain('✔');
    expect(result.debugLog).not.toContain('⏭');
  });

  it('runs a then: step whose when: holds', async () => {
    const { svc, mock } = makeApexEchoService(() => '');
    const scripts = [
      script({
        id: 'cat/parent',
        type: 'apex',
        script: 'body',
        inputs: [{ name: 'cartType' }],
        then: [{ script: 'cat/cart', when: '${cartType} !== "None"' }],
      }),
      script({ id: 'cat/cart', type: 'apex', script: 'CART' }),
    ];

    const result = await svc.executeScript('cat/parent', scripts, { cartType: 'Quote' });
    expect(result.success).toBe(true);
    expect(result.debugLog).not.toContain('skipped');
    expect(mock.executeAnonymousWithDebugLog).toHaveBeenCalledTimes(2);
  });

  it('evaluates when: against the body’s ::fc-output values', async () => {
    const { svc, mock } = makeApexEchoService((body) =>
      body === 'makes-cart' ? '12:00:00.0 (1)|USER_DEBUG|[1]|DEBUG|::fc-output cartId=CART01' : '',
    );
    const scripts = [
      // "only run if the body actually published a cartId"
      script({
        id: 'cat/with',
        type: 'apex',
        script: 'makes-cart',
        then: [{ script: 'cat/next', when: '${cartId}' }],
      }),
      script({
        id: 'cat/without',
        type: 'apex',
        script: 'no-cart',
        then: [{ script: 'cat/next', when: '${cartId}' }],
      }),
      script({ id: 'cat/next', type: 'apex', script: 'NEXT' }),
    ];

    await svc.executeScript('cat/with', scripts, {});
    expect(mock.executeAnonymousWithDebugLog).toHaveBeenCalledTimes(2);

    (mock.executeAnonymousWithDebugLog as ReturnType<typeof vi.fn>).mockClear();
    const without = await svc.executeScript('cat/without', scripts, {});
    expect(mock.executeAnonymousWithDebugLog).toHaveBeenCalledTimes(1);
    expect(without.debugLog).toContain('⏭ cat/next skipped');
  });

  it('guards one step on two conditions with && and ||', async () => {
    async function run(when: string, a: string, b: string) {
      const { svc, mock } = makeApexEchoService(() => '');
      const scripts = [
        script({
          id: 'cat/one',
          type: 'apex',
          script: 'ONE',
          inputs: [{ name: 'a' }, { name: 'b' }],
          then: [{ script: 'cat/two', when }],
        }),
        script({ id: 'cat/two', type: 'apex', script: 'TWO' }),
      ];
      await svc.executeScript('cat/one', scripts, { a, b });
      return (mock.executeAnonymousWithDebugLog as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => c[0],
      );
    }

    const AND = '${a} === "x" && ${b} === "y"';
    expect(await run(AND, 'x', 'y')).toEqual(['ONE', 'TWO']);
    expect(await run(AND, 'x', 'no')).toEqual(['ONE']);
    expect(await run(AND, 'no', 'y')).toEqual(['ONE']);

    const OR = '${a} === "x" || ${b} === "y"';
    expect(await run(OR, 'no', 'y')).toEqual(['ONE', 'TWO']);
    expect(await run(OR, 'no', 'no')).toEqual(['ONE']);
  });

  it('runs nested then: chains depth-first and bubbles every log up', async () => {
    const { svc, mock } = makeApexEchoService((body) => body);
    const scripts = [
      script({
        id: 'cat/root',
        type: 'apex',
        script: 'ROOT',
        then: [{ script: 'cat/x' }, { script: 'cat/y' }],
      }),
      script({ id: 'cat/x', type: 'apex', script: 'X', then: [{ script: 'cat/x1' }] }),
      script({ id: 'cat/x1', type: 'apex', script: 'X1' }),
      script({ id: 'cat/y', type: 'apex', script: 'Y' }),
    ];

    const result = await svc.executeScript('cat/root', scripts, {});

    expect(result.success).toBe(true);
    // x's own follow-up runs before y — depth-first, not breadth-first.
    expect(
      (mock.executeAnonymousWithDebugLog as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]),
    ).toEqual(['ROOT', 'X', 'X1', 'Y']);
    // A grandchild's log still reaches the script the user clicked.
    expect(result.debugLog).toContain('── ▶ cat/x1 ──');
  });

  it('detects a cycle created through then:', async () => {
    const { svc } = makeApexEchoService(() => '');
    const scripts = [
      script({ id: 'cat/a', type: 'apex', script: 'a', then: [{ script: 'cat/b' }] }),
      script({ id: 'cat/b', type: 'apex', script: 'b', then: [{ script: 'cat/a' }] }),
    ];

    const result = await svc.executeScript('cat/a', scripts, {});

    expect(result.success).toBe(false);
    expect(result.message).toContain('Circular script call');
  });

  it('writes exactly one execution log for a two-deep chain', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'force-chain-'));
    try {
      const mock = makeMock();
      (mock.executeAnonymousWithDebugLog as ReturnType<typeof vi.fn>).mockResolvedValue({
        compiled: true,
        success: true,
        debugLog: 'ok',
      });
      const svc = new YamlScriptsService(
        mock,
        {
          builtInPath: '',
          userPath: path.join(tmpDir, 'scripts'),
          privatePath: '',
          workspaceRoot: tmpDir,
        },
        makeGateway(),
        makeSkills(),
        makeDescribe(mock),
      );
      const scripts = [
        script({ id: 'cat/parent', type: 'js', script: `await runScript('cat/child');` }),
        script({ id: 'cat/child', type: 'apex', script: 'System.debug(1);' }),
      ];

      await svc.executeScript('cat/parent', scripts, {});

      const logFiles = fs.readdirSync(path.join(tmpDir, 'logs')).filter((f) => f.endsWith('.log'));
      expect(logFiles).toHaveLength(1);
      expect(logFiles[0]).toContain('cat_parent');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

/**
 * Chaining across script kinds: how a value published by one script reaches the
 * next when they are different types. Each kind has exactly one way to publish
 * (marker line for apex/command, setOutput() for js), which is easy to get
 * wrong, so the combinations are pinned here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runTerminalCommand = vi.fn();
vi.mock('../../../utils/terminalCommand', () => ({
  runTerminalCommand: (...args: unknown[]) => runTerminalCommand(...args),
}));

const { YamlScriptsService } = await import('./YamlScriptsService');
const { DescribeService } = await import('../../../services/describe/DescribeService');
const { SkillsRepository } = await import('../../../services/skills/SkillsRepository');
type CM = import('../../../salesforce/connection').ConnectionManager;
type LmGateway = import('../../../services/ai/types').LmGateway;
type YamlScript = import('./types').YamlScript;

function script(
  over: Partial<YamlScript> & Pick<YamlScript, 'id' | 'type' | 'script'>,
): YamlScript {
  return { folder: 'cat', name: over.id, description: '', source: 'user', ...over } as YamlScript;
}

function makeSvc(apexEcho: (body: string) => string = () => '') {
  const exec = vi.fn().mockImplementation(async (body: string) => ({
    compiled: true,
    success: true,
    debugLog: apexEcho(body),
  }));
  const cm = {
    executeAnonymousWithDebugLog: exec,
    query: vi.fn(),
    getConnection: vi.fn().mockReturnValue(null),
    getCurrentOrg: vi.fn().mockReturnValue(null),
  } as unknown as CM;
  const gateway: LmGateway = { listModels: async () => [], send: async function* () {} };
  const svc = new YamlScriptsService(
    cm,
    { builtInPath: '', userPath: '', privatePath: '', workspaceRoot: '' },
    gateway,
    new SkillsRepository('', []),
    new DescribeService(cm),
  );
  return { svc, exec };
}

const dbg = (line: string) => `12:00:00.0 (1)|USER_DEBUG|[1]|DEBUG|${line}`;

describe('cross-kind argument passing', () => {
  beforeEach(() => runTerminalCommand.mockReset());

  it('COMMAND publishes ::fc-output on stdout → apex step consumes it', async () => {
    runTerminalCommand.mockResolvedValue({
      success: true,
      output: 'building...\n::fc-output buildId=B-42\ndone',
    });
    const { svc, exec } = makeSvc();
    const scripts = [
      script({
        id: 'cat/build',
        type: 'command',
        script: 'npm run build',
        then: [{ script: 'cat/record', with: { buildId: '${buildId}' } }],
      }),
      script({
        id: 'cat/record',
        type: 'apex',
        script: "System.debug('build ${buildId}');",
        inputs: [{ name: 'buildId' }],
      }),
    ];

    const result = await svc.executeScript('cat/build', scripts, {});
    expect(result.success).toBe(true);
    expect(exec.mock.calls[0][0]).toBe("System.debug('build B-42');");
  });

  it('JS publishes via setOutput() → command step consumes it', async () => {
    runTerminalCommand.mockResolvedValue({ success: true, output: 'ok' });
    const { svc } = makeSvc();
    const scripts = [
      script({
        id: 'cat/pick',
        type: 'js',
        script: `setOutput('target', 'staging'); log('picked');`,
        then: [{ script: 'cat/deploy', with: { env: '${target}' } }],
      }),
      script({
        id: 'cat/deploy',
        type: 'command',
        script: 'deploy --env ${env}',
        inputs: [{ name: 'env' }],
      }),
    ];

    const result = await svc.executeScript('cat/pick', scripts, {});
    expect(result.success).toBe(true);
    expect(runTerminalCommand.mock.calls[0][0]).toBe('deploy --env staging');
  });

  it('JS: a ::fc-output line printed with log() is NOT picked up', async () => {
    const { svc, exec } = makeSvc();
    const scripts = [
      script({
        id: 'cat/js',
        type: 'js',
        script: `log('::fc-output foo=bar');`,
        then: [{ script: 'cat/next', with: { foo: '${foo}' } }],
      }),
      script({
        id: 'cat/next',
        type: 'apex',
        script: "System.debug('got ${foo}');",
        inputs: [{ name: 'foo' }],
      }),
    ];

    await svc.executeScript('cat/js', scripts, {});
    // Empty, not "bar" — js outputs come only from setOutput().
    expect(exec.mock.calls[0][0]).toBe("System.debug('got ');");
  });

  it('APEX → JS step: the value is JSON-escaped for the js body', async () => {
    const { svc } = makeSvc(() => dbg('::fc-output note=say "hi" & bye'));
    const scripts = [
      script({
        id: 'cat/a',
        type: 'apex',
        script: 'body',
        then: [{ script: 'cat/b', with: { note: '${note}' } }],
      }),
      script({
        id: 'cat/b',
        type: 'js',
        script: 'log("note is: ${note}");',
        inputs: [{ name: 'note' }],
      }),
    ];

    const result = await svc.executeScript('cat/a', scripts, {});
    expect(result.success).toBe(true);
    expect(result.debugLog).toContain('note is: say "hi" & bye');
  });

  it('a three-kind chain: command → js → apex', async () => {
    runTerminalCommand.mockResolvedValue({ success: true, output: '::fc-output sha=abc123' });
    const { svc, exec } = makeSvc();
    const scripts = [
      script({
        id: 'cat/one',
        type: 'command',
        script: 'git rev-parse HEAD',
        then: [{ script: 'cat/two', with: { sha: '${sha}' } }],
      }),
      script({
        id: 'cat/two',
        type: 'js',
        script: 'setOutput("short", "${sha}".slice(0, 3));',
        inputs: [{ name: 'sha' }],
        then: [{ script: 'cat/three', with: { short: '${short}' } }],
      }),
      script({
        id: 'cat/three',
        type: 'apex',
        script: "System.debug('short ${short}');",
        inputs: [{ name: 'short' }],
      }),
    ];

    const result = await svc.executeScript('cat/one', scripts, {});
    expect(result.success).toBe(true);
    expect(exec.mock.calls[0][0]).toBe("System.debug('short abc');");
  });
});

describe('cancellation propagation through chained scripts', () => {
  beforeEach(() => runTerminalCommand.mockReset());

  it('a then: step that is cancelled reports cancelled, not a wrapped failure', async () => {
    runTerminalCommand.mockResolvedValue({ cancelled: true });
    const { svc } = makeSvc();
    const scripts = [
      script({ id: 'cat/parent', type: 'apex', script: 'body', then: [{ script: 'cat/child' }] }),
      script({ id: 'cat/child', type: 'command', script: 'sleep 100' }),
    ];

    const result = await svc.executeScript('cat/parent', scripts, {});

    expect(result.success).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.debugLog).not.toContain('--- error ---');
    expect(result.debugLog).not.toContain('failed:');
  });

  it('a cancelled child reached via runScript() propagates cancelled, not a wrapped failure', async () => {
    runTerminalCommand.mockResolvedValue({ cancelled: true });
    const { svc } = makeSvc();
    const scripts = [
      script({ id: 'cat/parent', type: 'js', script: `await runScript('cat/child');` }),
      script({ id: 'cat/child', type: 'command', script: 'sleep 100' }),
    ];

    const result = await svc.executeScript('cat/parent', scripts, {});

    expect(result.success).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.debugLog).not.toContain('failed:');
  });
});

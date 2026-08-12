import { describe, expect, it, vi } from 'vitest';
import { JsExecutor } from './JsExecutor';
import type { ConnectionManager } from '../../../../salesforce/connection';
import type { MakeRunScript, YamlScript } from '../types';

function makeConnectionManager(): ConnectionManager {
  return {
    getConnection: vi.fn().mockReturnValue(null),
    getCurrentOrg: vi.fn().mockReturnValue(null),
    query: vi.fn(),
    executeAnonymousWithDebugLog: vi.fn(),
  } as unknown as ConnectionManager;
}

function makeScript(body: string): YamlScript {
  return {
    id: 'cat/js',
    folder: 'cat',
    name: 'JS',
    description: '',
    type: 'js',
    script: body,
    source: 'user',
  };
}

function run(body: string, makeRunScript?: MakeRunScript, onLogChunk?: (c: string) => void) {
  return new JsExecutor(makeConnectionManager()).execute(
    makeScript(body),
    undefined,
    onLogChunk,
    makeRunScript,
  );
}

describe('JsExecutor — setOutput', () => {
  it('collects values and coerces them to strings', async () => {
    const result = await run(`
      setOutput('id', '001xx');
      setOutput('count', 42);
      setOutput('ok', true);
    `);
    expect(result.success).toBe(true);
    expect(result.outputs).toEqual({ id: '001xx', count: '42', ok: 'true' });
  });

  it('returns an empty outputs object when the script sets none', async () => {
    const result = await run(`log('nothing to declare');`);
    expect(result.outputs).toEqual({});
  });

  it('keeps outputs set before a script threw', async () => {
    const result = await run(`
      setOutput('partial', 'yes');
      throw new Error('boom');
    `);
    expect(result.success).toBe(false);
    expect(result.outputs).toEqual({ partial: 'yes' });
  });

  it('lets a later setOutput overwrite an earlier one', async () => {
    const result = await run(`setOutput('x', 'first'); setOutput('x', 'second');`);
    expect(result.outputs).toEqual({ x: 'second' });
  });
});

describe('JsExecutor — runScript wiring', () => {
  it('exposes the runScript built by the factory', async () => {
    const runScript = vi.fn().mockResolvedValue({ success: true, outputs: { a: '1' } });
    const makeRunScript: MakeRunScript = () => runScript;

    const result = await run(
      `const r = await runScript('cat/other', { k: 'v' }); log('got ' + r.outputs.a);`,
      makeRunScript,
    );

    expect(runScript).toHaveBeenCalledWith('cat/other', { k: 'v' });
    expect(result.debugLog).toContain('got 1');
  });

  it('emits text from the factory into the log without doubling newlines', async () => {
    const chunks: string[] = [];
    const makeRunScript: MakeRunScript = (emit) => async () => {
      emit('── ▶ cat/child ──\n');
      emit('child line\n');
      return { scriptId: 'cat/child', success: true, message: '', debugLog: '' };
    };

    const result = await run(
      `log('before'); await runScript('cat/child'); log('after');`,
      makeRunScript,
      (c) => chunks.push(c),
    );

    // Emitted text reaches the final debugLog, not just the live stream — the
    // webview replaces the rendered log with debugLog once the run ends.
    expect(result.debugLog).toBe('before\n── ▶ cat/child ──\nchild line\nafter');
    expect(chunks.join('')).toBe('before\n── ▶ cat/child ──\nchild line\nafter\n');
  });

  it('leaves runScript undefined when no factory is supplied', async () => {
    const result = await run(`log(typeof runScript);`);
    expect(result.debugLog).toBe('undefined');
  });
});

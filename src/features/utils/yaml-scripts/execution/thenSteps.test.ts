import { describe, expect, it, vi } from 'vitest';
import { buildThenVars, runThenChain } from './thenSteps';
import type { ExecuteScriptResult, RunScriptFn, ScriptThenStep } from '../types';

function result(over: Partial<ExecuteScriptResult> = {}): ExecuteScriptResult {
  return { scriptId: 'child', success: true, message: '', debugLog: '', ...over };
}

describe('buildThenVars', () => {
  it('merges orgUsername, inputs and outputs, with outputs winning on collision', () => {
    expect(
      buildThenVars('bob@org', { cartType: 'Quote', accountId: '001' }, { accountId: '001NEW' }),
    ).toEqual({ orgUsername: 'bob@org', cartType: 'Quote', accountId: '001NEW' });
  });

  it('tolerates missing inputs/outputs', () => {
    expect(buildThenVars('bob@org', undefined, undefined)).toEqual({ orgUsername: 'bob@org' });
  });
});

describe('runThenChain', () => {
  it('runs every step in order, unguarded', async () => {
    const runStep = vi.fn().mockResolvedValue(result());
    const emit = vi.fn();
    const steps: ScriptThenStep[] = [{ script: 'cat/one' }, { script: 'cat/two' }];

    const outcome = await runThenChain(steps, {}, runStep, emit);

    expect(outcome).toEqual({});
    expect(runStep.mock.calls.map((c) => c[0])).toEqual(['cat/one', 'cat/two']);
  });

  it('resolves with: values against vars, raw (no escaping) and unresolved cleared', async () => {
    const runStep = vi.fn().mockResolvedValue(result());
    const steps: ScriptThenStep[] = [
      { script: 'cat/child', with: { accountId: '${accountId}', missing: '${nope}' } },
    ];

    await runThenChain(steps, { accountId: '001XYZ' }, runStep, vi.fn());

    expect(runStep).toHaveBeenCalledWith('cat/child', { accountId: '001XYZ', missing: '' });
  });

  it('skips a step whose when: is false and announces it', async () => {
    const runStep = vi.fn().mockResolvedValue(result());
    const emit = vi.fn();
    const steps: ScriptThenStep[] = [{ script: 'cat/cart', when: '${cartType} !== "Quote"' }];

    const outcome = await runThenChain(steps, { cartType: 'Quote' }, runStep, emit);

    expect(outcome).toEqual({});
    expect(runStep).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(expect.stringContaining('skipped'));
  });

  it('runs a step whose when: holds and announces it', async () => {
    const runStep = vi.fn().mockResolvedValue(result());
    const emit = vi.fn();
    const steps: ScriptThenStep[] = [{ script: 'cat/cart', when: '${cartType} === "Quote"' }];

    await runThenChain(steps, { cartType: 'Quote' }, runStep, emit);

    expect(runStep).toHaveBeenCalledWith('cat/cart', {});
    expect(emit).toHaveBeenCalledWith(expect.stringContaining('✔ cat/cart'));
  });

  it('does not announce an unguarded step', async () => {
    const emit = vi.fn();
    await runThenChain([{ script: 'cat/one' }], {}, vi.fn().mockResolvedValue(result()), emit);
    expect(emit).not.toHaveBeenCalled();
  });

  it('stops at the first failure and reports it, without running later steps', async () => {
    const runStep: RunScriptFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('Script "cat/bad" failed: boom'));
    const emit = vi.fn();
    const steps: ScriptThenStep[] = [{ script: 'cat/bad' }, { script: 'cat/never' }];

    const outcome = await runThenChain(steps, {}, runStep, emit);

    expect(outcome).toEqual({ success: false, message: 'Script "cat/bad" failed: boom' });
    expect(runStep).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(expect.stringContaining('--- error ---'));
  });

  it('translates a cancellation into a cancelled outcome without an error line', async () => {
    const runStep: RunScriptFn = vi.fn().mockRejectedValue(new Error('Operation cancelled'));
    const emit = vi.fn();

    const outcome = await runThenChain([{ script: 'cat/one' }], {}, runStep, emit);

    expect(outcome).toEqual({ cancelled: true, success: false, message: '' });
    expect(emit).not.toHaveBeenCalledWith(expect.stringContaining('--- error ---'));
  });
});

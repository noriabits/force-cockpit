import { describe, expect, it, vi } from 'vitest';
import type { ConnectionManager } from '../../../salesforce/connection';
import { findPreset } from '../explorer/debugLevelPresets';
import { AnonymousApexService, toSoapLogLevels } from './AnonymousApexService';

const LOG = [
  '65.0 APEX_CODE,DEBUG;DB,INFO',
  '12:00:00.0 (1)|USER_DEBUG|[1]|DEBUG|hello',
  '12:00:00.0 (2)|EXCEPTION_THROWN|[2]|System.MathException: Divide by 0',
  '12:00:00.0 (3)|FATAL_ERROR|System.MathException: Divide by 0',
].join('\n');

function soapResult(over: Record<string, unknown> = {}) {
  return {
    compiled: true,
    success: true,
    compileProblem: null,
    line: null,
    column: null,
    exceptionMessage: null,
    exceptionStackTrace: null,
    debugLog: LOG,
    ...over,
  };
}

function makeMock(result: unknown | Promise<unknown> = soapResult()) {
  const executeAnonymousWithDebugLog = vi.fn(async () => result);
  return {
    cm: { executeAnonymousWithDebugLog } as unknown as ConnectionManager,
    executeAnonymousWithDebugLog,
  };
}

describe('toSoapLogLevels', () => {
  it('maps every TraceFlag category onto its DebuggingHeader name', () => {
    expect(toSoapLogLevels(findPreset('user-debug-only')!.levels)).toEqual({
      Apex_code: 'DEBUG',
      Apex_profiling: 'NONE',
      Callout: 'NONE',
      Db: 'NONE',
      System: 'ERROR',
      Validation: 'NONE',
      Visualforce: 'NONE',
      Workflow: 'NONE',
    });
  });
});

describe('AnonymousApexService.execute', () => {
  it('runs with the chosen preset’s levels', async () => {
    const { cm, executeAnonymousWithDebugLog } = makeMock();
    await new AnonymousApexService(cm).execute('System.debug(1);', 'soql-deep-dive');
    expect(executeAnonymousWithDebugLog).toHaveBeenCalledWith('System.debug(1);', {
      logLevels: toSoapLogLevels(findPreset('soql-deep-dive')!.levels),
    });
  });

  it('falls back to the recommended preset for an unknown id', async () => {
    const { cm, executeAnonymousWithDebugLog } = makeMock();
    await new AnonymousApexService(cm).execute('x();', 'nope');
    expect(executeAnonymousWithDebugLog).toHaveBeenCalledWith('x();', {
      logLevels: toSoapLogLevels(findPreset('balanced')!.levels),
    });
  });

  it('parses the log with the Debug Logs pipeline', async () => {
    const { cm } = makeMock();
    const out = await new AnonymousApexService(cm).execute('x();', 'balanced');
    expect(out.log).toMatchObject({ body: LOG, partial: false, totalLines: 4 });
    expect(out.log!.events).toHaveLength(4);
    expect((out.log!.summary as { counts: { userDebug: number } }).counts.userDebug).toBe(1);
    expect((out.log!.issues as { rule: string }[]).some((i) => i.rule === 'exception')).toBe(true);
  });

  it('returns a compile error as an outcome, with its position and no log', async () => {
    const { cm } = makeMock(
      soapResult({
        compiled: false,
        success: false,
        compileProblem: "Unexpected token ';'.",
        line: 2,
        column: 13,
        debugLog: '',
      }),
    );
    const out = await new AnonymousApexService(cm).execute('x', 'balanced');
    expect(out).toMatchObject({ compiled: false, line: 2, column: 13, log: null });
  });

  it('returns an uncaught exception as an outcome, keeping the log', async () => {
    const { cm } = makeMock(
      soapResult({ success: false, exceptionMessage: 'System.MathException: Divide by 0' }),
    );
    const out = await new AnonymousApexService(cm).execute('x', 'balanced');
    expect(out.success).toBe(false);
    expect(out.exceptionMessage).toContain('Divide by 0');
    expect(out.log).not.toBeNull();
  });

  it('refuses blank code without calling the org', async () => {
    const { cm, executeAnonymousWithDebugLog } = makeMock();
    await expect(new AnonymousApexService(cm).execute('  \n', 'balanced')).rejects.toThrow(
      'Nothing to execute.',
    );
    expect(executeAnonymousWithDebugLog).not.toHaveBeenCalled();
  });

  it('stops waiting on cancel with the shared sentinel', async () => {
    const { cm } = makeMock(new Promise(() => {}));
    const ac = new AbortController();
    const run = new AnonymousApexService(cm).execute('x();', 'balanced', ac.signal);
    ac.abort();
    await expect(run).rejects.toThrow('Operation cancelled');
  });
});

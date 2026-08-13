import { describe, expect, it, vi } from 'vitest';
import { capProbe, createValidateSoqlTool } from './validateSoqlTool';
import type { QueryService } from '../QueryService';
import type { SoqlDiagnostic, SoqlDiagnosticsService } from '../SoqlDiagnosticsService';

function makeTool(
  overrides: {
    runQuery?: QueryService['runQuery'];
    diagnose?: (soql: string, message: string) => Promise<SoqlDiagnostic[]>;
    onValidated?: (soql: string, useToolingApi: boolean) => void;
    signal?: AbortSignal;
  } = {},
) {
  const runQuery =
    overrides.runQuery ??
    vi.fn(async () => ({ records: [{ Id: '001', Name: 'Acme' }], totalSize: 1, done: true }));
  const diagnose = overrides.diagnose ?? vi.fn(async () => [] as SoqlDiagnostic[]);
  const tool = createValidateSoqlTool({
    queryService: { runQuery } as unknown as QueryService,
    diagnostics: { diagnose } as unknown as SoqlDiagnosticsService,
    getSignal: () => overrides.signal,
    onValidated: overrides.onValidated,
  });
  return { tool, runQuery, diagnose };
}

const noop = () => {};

describe('capProbe', () => {
  it('appends LIMIT 1 when there is no LIMIT', () => {
    expect(capProbe('SELECT Id FROM Account')).toBe('SELECT Id FROM Account LIMIT 1');
  });

  it('leaves an existing trailing LIMIT alone', () => {
    expect(capProbe('SELECT Id FROM Account LIMIT 5')).toBe('SELECT Id FROM Account LIMIT 5');
  });

  it('still caps a query whose only LIMIT belongs to a sub-query', () => {
    // The sub-query's LIMIT is never last, so the outer statement is uncapped.
    expect(capProbe('SELECT Id, (SELECT Id FROM Contacts LIMIT 5) FROM Account')).toBe(
      'SELECT Id, (SELECT Id FROM Contacts LIMIT 5) FROM Account LIMIT 1',
    );
  });

  it('normalises surrounding whitespace and a trailing semicolon', () => {
    expect(capProbe('  SELECT Id FROM Account;  ')).toBe('SELECT Id FROM Account LIMIT 1');
  });

  it('caps an aggregate query', () => {
    expect(capProbe('SELECT COUNT() FROM Account')).toBe('SELECT COUNT() FROM Account LIMIT 1');
  });
});

describe('validate_soql', () => {
  it('rejects a non-SELECT payload without touching the org', async () => {
    const { tool, runQuery } = makeTool();
    const result = await tool.run({ soql: 'DELETE FROM Account' }, noop);
    expect(result).toMatch(/only SELECT/i);
    expect(runQuery).not.toHaveBeenCalled();
  });

  it('rejects an empty query', async () => {
    const { tool, runQuery } = makeTool();
    expect(await tool.run({ soql: '   ' }, noop)).toMatch(/no SOQL query/i);
    expect(runQuery).not.toHaveBeenCalled();
  });

  it('reports the fields the query actually returned', async () => {
    const { tool } = makeTool();
    const result = JSON.parse(
      String(await tool.run({ soql: 'SELECT Id, Name FROM Account' }, noop)),
    );
    expect(result).toMatchObject({
      ok: true,
      rowCount: 1,
      returnedFields: ['Id', 'Name'],
      sampleRow: { Id: '001', Name: 'Acme' },
    });
  });

  it('strips jsforce record attributes from the sample row', async () => {
    const { tool } = makeTool({
      runQuery: vi.fn(async () => ({
        records: [{ attributes: { type: 'Account' }, Id: '001' }],
        totalSize: 1,
        done: true,
      })) as unknown as QueryService['runQuery'],
    });
    const result = JSON.parse(String(await tool.run({ soql: 'SELECT Id FROM Account' }, noop)));
    expect(result.returnedFields).toEqual(['Id']);
    expect(result.sampleRow).toEqual({ Id: '001' });
  });

  it('warns when the query is valid but matched nothing', async () => {
    const { tool } = makeTool({
      runQuery: vi.fn(async () => ({ records: [], totalSize: 0, done: true })),
    });
    const result = JSON.parse(String(await tool.run({ soql: 'SELECT Id FROM Account' }, noop)));
    expect(result.ok).toBe(true);
    expect(result.rowCount).toBe(0);
    expect(result.warning).toMatch(/matched no records/i);
  });

  it('runs the probe against the Tooling API when asked', async () => {
    const { tool, runQuery } = makeTool();
    await tool.run({ soql: 'SELECT Id FROM ApexClass', useToolingApi: true }, noop);
    expect(runQuery).toHaveBeenCalledWith('SELECT Id FROM ApexClass LIMIT 1', true, undefined);
  });

  describe('failure', () => {
    const failing = vi.fn(async () => {
      throw new Error("No such column 'CloseDat' on entity 'Opportunity'.");
    }) as unknown as QueryService['runQuery'];

    it('returns the verbatim Salesforce error plus diagnostics', async () => {
      const diagnostic: SoqlDiagnostic = {
        severity: 'info',
        title: 'No such field',
        detail: 'Opportunity has no field CloseDat.',
        suggestions: ['CloseDate'],
      };
      const { tool, diagnose } = makeTool({
        runQuery: failing,
        diagnose: vi.fn(async () => [diagnostic]),
      });

      const result = JSON.parse(
        String(await tool.run({ soql: 'SELECT CloseDat FROM Opportunity' }, noop)),
      );

      expect(result.ok).toBe(false);
      expect(result.error).toBe("No such column 'CloseDat' on entity 'Opportunity'.");
      expect(result.diagnostics).toEqual([diagnostic]);
      // diagnose sees the ORIGINAL query, not the probe-capped one.
      expect(diagnose).toHaveBeenCalledWith(
        'SELECT CloseDat FROM Opportunity',
        "No such column 'CloseDat' on entity 'Opportunity'.",
      );
    });

    it('propagates a cancellation instead of reporting it as a repairable failure', async () => {
      const { tool, diagnose } = makeTool({
        runQuery: vi.fn(async () => {
          throw new Error('Operation cancelled');
        }) as unknown as QueryService['runQuery'],
      });

      await expect(tool.run({ soql: 'SELECT Id FROM Account' }, noop)).rejects.toThrow(
        'Operation cancelled',
      );
      expect(diagnose).not.toHaveBeenCalled();
    });
  });

  describe('onValidated', () => {
    it('fires with the original query on success', async () => {
      const onValidated = vi.fn();
      const { tool } = makeTool({ onValidated });
      await tool.run({ soql: 'SELECT Id FROM Account', useToolingApi: true }, noop);
      expect(onValidated).toHaveBeenCalledWith('SELECT Id FROM Account', true);
    });

    it('does not fire on failure', async () => {
      const onValidated = vi.fn();
      const { tool } = makeTool({
        onValidated,
        runQuery: vi.fn(async () => {
          throw new Error('MALFORMED_QUERY');
        }) as unknown as QueryService['runQuery'],
      });
      await tool.run({ soql: 'SELECT Id FROM Account' }, noop);
      expect(onValidated).not.toHaveBeenCalled();
    });
  });
});

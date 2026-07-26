import { describe, expect, it } from 'vitest';
import type { ConnectionManager } from '../../../salesforce/connection';
import { fakeConnectionManager } from '../__fixtures__/fakeGateway';
import { createCurrentUserTool, createRunSoqlTool } from './orgTools';

function makeCM(overrides: Record<string, unknown> = {}): ConnectionManager {
  return fakeConnectionManager(overrides) as unknown as ConnectionManager;
}

describe('createRunSoqlTool', () => {
  it('runs the Standard API by default', async () => {
    const cm = makeCM();
    const tool = createRunSoqlTool(cm);
    const chunks: string[] = [];
    const result = await tool.run({ soql: 'SELECT Id FROM Account' }, (s) => chunks.push(s));

    expect(cm.query).toHaveBeenCalledWith('SELECT Id FROM Account');
    expect((cm as unknown as { toolingQuery: unknown }).toolingQuery).not.toHaveBeenCalled();
    expect(result).toContain('Acme');
    expect(chunks.join('')).toContain('[run_soql] SELECT Id FROM Account');
    expect(chunks.join('')).not.toContain('(tooling)');
  });

  it('runs the Tooling API when useToolingApi is set — e.g. FieldDefinition', async () => {
    const cm = makeCM();
    const tool = createRunSoqlTool(cm);
    const chunks: string[] = [];
    const soql =
      "SELECT QualifiedApiName, Label, DataType FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = 'Account'";
    const result = await tool.run({ soql, useToolingApi: true }, (s) => chunks.push(s));

    expect(
      (cm as unknown as { toolingQuery: (q: string) => unknown }).toolingQuery,
    ).toHaveBeenCalledWith(soql);
    expect(cm.query).not.toHaveBeenCalled();
    expect(result).toContain('My_Field__c');
    expect(chunks.join('')).toContain('[run_soql] (tooling)');
  });

  it('ignores a falsy useToolingApi and still uses the Standard API', async () => {
    const cm = makeCM();
    const tool = createRunSoqlTool(cm);
    await tool.run({ soql: 'SELECT Id FROM Account', useToolingApi: false }, () => {});
    expect(cm.query).toHaveBeenCalled();
    expect((cm as unknown as { toolingQuery: unknown }).toolingQuery).not.toHaveBeenCalled();
  });

  it('rejects a non-SELECT query before running it, tooling or not', async () => {
    const cm = makeCM();
    const tool = createRunSoqlTool(cm);
    const result = await tool.run({ soql: 'DELETE FROM Account', useToolingApi: true }, () => {});
    expect(result).toMatch(/only SELECT\/SOQL queries are allowed/i);
    expect(cm.query).not.toHaveBeenCalled();
    expect((cm as unknown as { toolingQuery: unknown }).toolingQuery).not.toHaveBeenCalled();
  });

  it('feeds back an error when the tooling query throws', async () => {
    const cm = makeCM({
      toolingQuery: async () => {
        throw new Error('INVALID_TYPE: FieldDefinition');
      },
    });
    const tool = createRunSoqlTool(cm);
    const result = await tool.run(
      { soql: 'SELECT QualifiedApiName FROM FieldDefinition', useToolingApi: true },
      () => {},
    );
    expect(result).toContain('INVALID_TYPE: FieldDefinition');
  });

  it('requires a SOQL string', async () => {
    const cm = makeCM();
    const tool = createRunSoqlTool(cm);
    const result = await tool.run({}, () => {});
    expect(result).toMatch(/no soql query provided/i);
  });
});

describe('createCurrentUserTool', () => {
  it('returns the connected username without an org round-trip', async () => {
    const cm = makeCM({
      getCurrentOrg: () => ({
        username: 'u@example.com',
        orgId: '00Dxx0000000001',
        instanceUrl: 'https://example.my.salesforce.com',
      }),
    });
    const tool = createCurrentUserTool(cm);
    const chunks: string[] = [];
    const result = await tool.run({}, (s) => chunks.push(s));

    expect(result).toContain('u@example.com');
    expect(result).toContain('00Dxx0000000001');
    expect(chunks.join('')).toContain('[get_current_user]');
    expect(chunks.join('')).toContain('u@example.com');
  });

  it('errors when no org is connected', async () => {
    const cm = makeCM({ getCurrentOrg: () => null });
    const tool = createCurrentUserTool(cm);
    const result = await tool.run({}, () => {});
    expect(result).toMatch(/no org is currently connected/i);
  });
});

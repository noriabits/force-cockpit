/**
 * Guards the example plugins in `force-cockpit/plugins/**`. Like the example
 * scripts, these do NOT ship in the .vsix (`.vscodeignore` excludes
 * `force-cockpit/**`) — they reach users by cloning the repo. A typo in one
 * surfaces as an error card rather than a build failure, so they are worth
 * discovering and running for real here.
 */
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { PluginRegistry } from './PluginRegistry';
import { PluginHost } from './PluginHost';
import { createSensitiveGate } from './sensitiveGate';
import type { OrgType } from '../../utils/orgType';
import type { ConnectionManager } from '../../salesforce/connection';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const PLUGINS_DIR = path.join(REPO_ROOT, 'force-cockpit', 'plugins');

const registry = () => new PluginRegistry(PLUGINS_DIR, path.join(PLUGINS_DIR, '__none__'));

function makeHost(cm: Partial<ConnectionManager>, orgType: OrgType = 'sandbox') {
  const confirm = vi.fn().mockResolvedValue(true);
  const host = new PluginHost({
    connectionManager: {
      getConnection: () => null,
      getCurrentOrg: () => null,
      ...cm,
    } as unknown as ConnectionManager,
    workspaceRoot: REPO_ROOT,
    registry: registry(),
    gate: createSensitiveGate({ resolveOrgType: async () => orgType, confirm }),
  });
  return { host, confirm };
}

const JOB_ROW = {
  Id: '707xx0000000001AAA',
  Status: 'Processing',
  JobType: 'BatchApex',
  MethodName: null,
  ApexClass: { Name: 'BatchAccountFix' },
  CreatedBy: { Name: 'Jane Smith' },
  JobItemsProcessed: 12,
  TotalJobItems: 40,
  NumberOfErrors: 3,
  ExtendedStatus: 'First error: too many SOQL queries',
  CreatedDate: '2026-01-01T00:00:00.000Z',
  CompletedDate: null,
};

describe('bundled example plugins', () => {
  it('all discover without an invalid card', () => {
    const plugins = registry().list();
    expect(plugins.length).toBeGreaterThan(0);
    expect(plugins.filter((p) => p.invalid)).toEqual([]);
  });

  describe('apex-jobs', () => {
    it('projects an AsyncApexJob row into the shape the panel renders', async () => {
      const query = vi.fn().mockResolvedValue({ totalSize: 1, records: [JOB_ROW] });
      const { host } = makeHost({ query });

      const rows = await host.invoke('apex-jobs', 'list', { filter: 'active' });

      expect(rows).toEqual([
        {
          id: '707xx0000000001AAA',
          status: 'Processing',
          jobType: 'BatchApex',
          name: 'BatchAccountFix',
          submittedBy: 'Jane Smith',
          processed: 12,
          total: 40,
          errors: 3,
          extendedStatus: 'First error: too many SOQL queries',
          createdDate: '2026-01-01T00:00:00.000Z',
          completedDate: null,
          abortable: true,
        },
      ]);
    });

    it('falls back to the method name for a job with no Apex class', async () => {
      const query = vi.fn().mockResolvedValue({
        totalSize: 1,
        records: [{ ...JOB_ROW, ApexClass: null, MethodName: 'sendEmailAsync' }],
      });
      const { host } = makeHost({ query });

      const rows = (await host.invoke('apex-jobs', 'list', {})) as { name: string }[];

      expect(rows[0].name).toBe('sendEmailAsync');
    });

    it('marks a finished job unabortable, so the panel offers no stop button', async () => {
      const query = vi.fn().mockResolvedValue({
        totalSize: 1,
        records: [{ ...JOB_ROW, Status: 'Completed' }],
      });
      const { host } = makeHost({ query });

      const rows = (await host.invoke('apex-jobs', 'list', {})) as { abortable: boolean }[];

      expect(rows[0].abortable).toBe(false);
    });

    // The panel sends a filter KEY, never SOQL. An unknown key must fall
    // through to no filter rather than reaching the query.
    it.each([
      ['active', "WHERE Status IN ('Holding', 'Queued', 'Preparing', 'Processing')"],
      ['failed', "WHERE Status IN ('Failed')"],
      ['finished', "WHERE Status IN ('Completed', 'Aborted')"],
    ])('turns the %s filter into its own WHERE clause', async (filter, expected) => {
      const query = vi.fn().mockResolvedValue({ totalSize: 0, records: [] });
      const { host } = makeHost({ query });

      await host.invoke('apex-jobs', 'list', { filter });

      expect(query.mock.calls[0][0]).toContain(expected);
    });

    // The injection-shaped key is not on Object.prototype, so it always fell
    // through correctly — this case passed even while the prototype-shaped keys
    // below were breaking the handler.
    it('ignores a filter key it does not recognise instead of interpolating it', async () => {
      const query = vi.fn().mockResolvedValue({ totalSize: 0, records: [] });
      const { host } = makeHost({ query });

      await host.invoke('apex-jobs', 'list', { filter: "x') OR (Id != null" });

      const soql = query.mock.calls[0][0] as string;
      expect(soql).not.toContain('OR (Id != null');
      expect(soql).not.toContain('WHERE');
    });

    // On an object literal these resolve through the prototype chain to a
    // truthy value, so they passed the `statuses` check and then threw
    // `statuses.join is not a function`. An unknown key must mean no filter,
    // whatever its name.
    it.each(['__proto__', 'constructor', 'toString', 'valueOf'])(
      'treats the inherited key %s as no filter at all',
      async (filter) => {
        const query = vi.fn().mockResolvedValue({ totalSize: 0, records: [] });
        const { host } = makeHost({ query });

        await expect(host.invoke('apex-jobs', 'list', { filter })).resolves.toEqual([]);
        expect(query.mock.calls[0][0]).not.toContain('WHERE');
      },
    );

    it('aborts a job through anonymous Apex', async () => {
      const executeAnonymousWithDebugLog = vi.fn().mockResolvedValue({ success: true });
      const { host, confirm } = makeHost({ executeAnonymousWithDebugLog });

      await expect(
        host.invoke('apex-jobs', 'abort', { jobId: '707xx0000000001AAA' }),
      ).resolves.toEqual({ aborted: '707xx0000000001AAA' });

      expect(executeAnonymousWithDebugLog).toHaveBeenCalledWith(
        "System.abortJob('707xx0000000001AAA');",
        undefined,
      );
      expect(confirm).not.toHaveBeenCalled(); // plain sandbox
    });

    it('surfaces the Salesforce message when the job already finished', async () => {
      const executeAnonymousWithDebugLog = vi.fn().mockResolvedValue({
        success: false,
        exceptionMessage: 'Job does not exist or is already finished',
      });
      const { host } = makeHost({ executeAnonymousWithDebugLog });

      await expect(
        host.invoke('apex-jobs', 'abort', { jobId: '707xx0000000001AAA' }),
      ).rejects.toThrow('Job does not exist or is already finished');
    });

    // The id ends up inside an Apex string literal, so it is refused rather
    // than escaped.
    it.each([["707xx'); System.abortJob('x"], ['not-an-id'], ['']])(
      'refuses %s as a job Id',
      async (jobId) => {
        const executeAnonymousWithDebugLog = vi.fn();
        const { host } = makeHost({ executeAnonymousWithDebugLog });

        await expect(host.invoke('apex-jobs', 'abort', { jobId })).rejects.toThrow(
          'is not a valid job Id',
        );
        expect(executeAnonymousWithDebugLog).not.toHaveBeenCalled();
      },
    );

    // The example is the documentation for the gate: it carries no
    // confirmation code of its own, and must still prompt on a production org.
    it('is gated on a production org despite asking for nothing itself', async () => {
      const executeAnonymousWithDebugLog = vi.fn().mockResolvedValue({ success: true });
      const confirm = vi.fn().mockResolvedValue(false);
      const host = new PluginHost({
        connectionManager: {
          getConnection: () => null,
          getCurrentOrg: () => null,
          executeAnonymousWithDebugLog,
        } as unknown as ConnectionManager,
        workspaceRoot: REPO_ROOT,
        registry: registry(),
        gate: createSensitiveGate({ resolveOrgType: async () => 'production', confirm }),
      });

      await expect(
        host.invoke('apex-jobs', 'abort', { jobId: '707xx0000000001AAA' }),
      ).rejects.toThrow('Operation cancelled');

      expect(confirm.mock.calls[0][0]).toContain('Apex Jobs');
      expect(executeAnonymousWithDebugLog).not.toHaveBeenCalled();
    });

    it('never prompts for the read-only list, even on production', async () => {
      const query = vi.fn().mockResolvedValue({ totalSize: 0, records: [] });
      const { host, confirm } = makeHost({ query }, 'production');

      await host.invoke('apex-jobs', 'list', { filter: 'active' });

      expect(confirm).not.toHaveBeenCalled();
    });
  });
});

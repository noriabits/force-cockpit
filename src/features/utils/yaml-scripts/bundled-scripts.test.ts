/**
 * Guards the scripts bundled with the extension (`force-cockpit/scripts/**`),
 * which ship in the .vsix and show up in every user's Scripts tab. A typo in one
 * of them surfaces as an error card rather than a build failure, so it is worth
 * parsing them for real here.
 */
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { YamlScriptsService } from './YamlScriptsService';
import type { ConnectionManager } from '../../../salesforce/connection';
import { DescribeService } from '../../../services/describe/DescribeService';
import { SkillsRepository } from '../../../services/skills/SkillsRepository';
import type { LmGateway } from '../../../services/ai/types';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

function makeService(echo: (body: string) => string = () => '') {
  const exec = vi.fn().mockImplementation(async (body: string) => ({
    compiled: true,
    success: true,
    debugLog: echo(body),
  }));
  const cm = {
    executeAnonymousWithDebugLog: exec,
    query: vi.fn(),
    getConnection: vi.fn().mockReturnValue(null),
    getCurrentOrg: vi.fn().mockReturnValue({ username: 'me@test.org' }),
  } as unknown as ConnectionManager;
  const gateway: LmGateway = { listModels: async () => [], send: async function* () {} };
  const svc = new YamlScriptsService(
    cm,
    {
      builtInPath: '',
      userPath: path.join(REPO_ROOT, 'force-cockpit', 'scripts'),
      privatePath: '',
      workspaceRoot: REPO_ROOT,
    },
    gateway,
    new SkillsRepository('', []),
    new DescribeService(cm),
  );
  return { svc, exec };
}

const debugLine = (text: string) => `12:00:00.0 (1)|USER_DEBUG|[1]|DEBUG|${text}`;

describe('bundled scripts', () => {
  it('every bundled script parses without a validation error', async () => {
    const scripts = await makeService().svc.loadScripts();
    expect(scripts.length).toBeGreaterThan(0);
    expect(scripts.filter((s) => s.invalid).map((s) => `${s.id}: ${s.error}`)).toEqual([]);
  });

  describe('the chained example', () => {
    const ID = 'examples/create-account-chained';
    const echo = (body: string) =>
      body.includes('new Account') ? debugLine('::fc-output accountId=001AAA') : debugLine('ok');

    it('passes the new account id to the contact script when asked', async () => {
      const { svc, exec } = makeService(echo);
      const scripts = await svc.loadScripts();
      const result = await svc.executeScript(ID, scripts, {
        accountName: 'Acme',
        createContact: 'true',
      });

      expect(result.success).toBe(true);
      expect(exec).toHaveBeenCalledTimes(2);
      expect(exec.mock.calls[1][0]).toContain("AccountId = '001AAA'");
      expect(exec.mock.calls[1][0]).toContain("LastName = 'Acme'");
    });

    it('loops over the supplied names with runScript, collecting each new id', async () => {
      let n = 0;
      const { svc, exec } = makeService(() => debugLine(`::fc-output contactId=003AAA${++n}`));
      const scripts = await svc.loadScripts();

      const result = await svc.executeScript('examples/bulk-create-contacts', scripts, {
        accountId: '001AAA',
        lastNames: "Alpha\nO'Brien\n\nGamma",
      });

      expect(result.success).toBe(true);
      // Three names — the blank line is dropped.
      expect(exec).toHaveBeenCalledTimes(3);
      expect(exec.mock.calls[1][0]).toContain("LastName = 'O\\'Brien'");
      expect(result.debugLog).toContain('Created 3 of 3: 003AAA1, 003AAA2, 003AAA3');
    });

    it('keeps going when one contact fails, then reports it', async () => {
      let n = 0;
      const { svc } = makeService();
      const scripts = await svc.loadScripts();
      // Second row fails; the other two must still run.
      const cm = (
        svc as unknown as { connectionManager: { executeAnonymousWithDebugLog: unknown } }
      ).connectionManager;
      (cm.executeAnonymousWithDebugLog as ReturnType<typeof vi.fn>).mockImplementation(
        async (body: string) => {
          n += 1;
          return body.includes('Bad')
            ? { compiled: false, success: false, compileProblem: 'nope' }
            : {
                compiled: true,
                success: true,
                debugLog: debugLine(`::fc-output contactId=00${n}`),
              };
        },
      );

      const result = await svc.executeScript('examples/bulk-create-contacts', scripts, {
        accountId: '001AAA',
        lastNames: 'Good\nBad\nAlsoGood',
      });

      expect(result.success).toBe(false);
      expect(result.debugLog).toContain('Created 2 of 3');
      expect(result.message).toContain('1 contact(s) could not be created');
    });

    it('skips the contact script when the checkbox is unticked', async () => {
      const { svc, exec } = makeService(echo);
      const scripts = await svc.loadScripts();
      const result = await svc.executeScript(ID, scripts, {
        accountName: 'Acme',
        createContact: 'false',
      });

      expect(result.success).toBe(true);
      expect(exec).toHaveBeenCalledTimes(1);
      expect(result.debugLog).toContain('⏭ examples/create-contact-for-account skipped');
    });
  });
});

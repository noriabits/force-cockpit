import { describe, expect, it, vi } from 'vitest';
import { createSensitiveGate } from './sensitiveGate';
import type { OrgType } from '../../utils/orgType';
import type { SandboxContext } from '../sandbox/buildSandboxContext';

function makeContext() {
  return {
    executeApex: vi.fn().mockResolvedValue('apex-ok'),
    restCall: vi.fn().mockResolvedValue('rest-ok'),
    run: vi.fn().mockResolvedValue('run-ok'),
    query: vi.fn().mockResolvedValue('query-ok'),
  };
}

function setup(orgType: OrgType, confirmResult = true) {
  const confirm = vi.fn().mockResolvedValue(confirmResult);
  const gate = createSensitiveGate({ resolveOrgType: async () => orgType, confirm });
  const raw = makeContext();
  const gated = gate(raw as unknown as SandboxContext, 'Order Explorer') as unknown as ReturnType<
    typeof makeContext
  >;
  return { raw, gated, confirm };
}

describe('createSensitiveGate', () => {
  it('prompts for nothing on a plain sandbox', async () => {
    const { gated, confirm, raw } = setup('sandbox');
    await gated.executeApex('update x;');
    await gated.restCall('POST', '/x');
    await gated.run('ls');
    expect(confirm).not.toHaveBeenCalled();
    expect(raw.executeApex).toHaveBeenCalledWith('update x;');
  });

  it.each<OrgType>(['production', 'protected-sandbox'])('gates executeApex on %s', async (org) => {
    const { gated, confirm } = setup(org);
    await expect(gated.executeApex('update x;')).resolves.toBe('apex-ok');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toContain('Order Explorer');
    expect(confirm.mock.calls[0][0]).toContain('run Apex');
  });

  it('names production and a protected sandbox differently in the prompt', async () => {
    const prod = setup('production');
    await prod.gated.run('ls');
    expect(prod.confirm.mock.calls[0][0]).toContain('a production org');

    const prot = setup('protected-sandbox');
    await prot.gated.run('ls');
    expect(prot.confirm.mock.calls[0][0]).toContain('a protected sandbox');
  });

  it('gates a destructive restCall but never a GET', async () => {
    const { gated, confirm, raw } = setup('production');
    await gated.restCall('get', '/read');
    expect(confirm).not.toHaveBeenCalled();
    expect(raw.restCall).toHaveBeenCalledWith('get', '/read');

    await gated.restCall('delete', '/thing');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toContain('DELETE');
  });

  it('leaves query untouched', async () => {
    const { gated, confirm } = setup('production');
    await expect(gated.query('SELECT Id FROM Account')).resolves.toBe('query-ok');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('throws the shared cancellation sentinel when the prompt is declined', async () => {
    const { gated, raw } = setup('production', false);
    await expect(gated.executeApex('update x;')).rejects.toThrow('Operation cancelled');
    // and the mutation never reached the org
    expect(raw.executeApex).not.toHaveBeenCalled();
  });

  // Both directions of the per-invoke latch.
  it('prompts once for a hundred mutations inside one invoke', async () => {
    const { gated, confirm, raw } = setup('production');
    for (let i = 0; i < 100; i++) await gated.executeApex(`update x${i};`);
    await gated.run('ls');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(raw.executeApex).toHaveBeenCalledTimes(100);
  });

  it('prompts again on the next invoke — the latch does not outlive the wrapper', async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    const gate = createSensitiveGate({ resolveOrgType: async () => 'production', confirm });

    for (let i = 0; i < 2; i++) {
      const ctx = gate(makeContext() as unknown as SandboxContext, 'P');
      await (ctx.executeApex as (s: string) => Promise<unknown>)('update x;');
    }
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('shows one modal, not several, for concurrent mutations', async () => {
    const { gated, confirm } = setup('production');
    await Promise.all([gated.executeApex('a;'), gated.executeApex('b;'), gated.run('ls')]);
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});

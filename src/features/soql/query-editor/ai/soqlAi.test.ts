// Covers the glue that turns a model answer into a runnable proposal. The
// thread mechanics themselves are ChatSession's (see ChatSession.test.ts); what
// matters here is that the proposal runs against the API it was actually
// validated on, rather than whichever one the model remembered to write down.
import { describe, expect, it, vi } from 'vitest';
import { createSoqlAi } from './soqlAi';
import { FakeGateway } from '../../../../services/ai/__fixtures__/fakeGateway';
import type { ChatEvent } from '../../../../services/ai/types';
import type { ConnectionManager } from '../../../../salesforce/connection';
import type { DescribeService } from '../../../../services/describe/DescribeService';
import type { QueryService } from '../QueryService';
import type { SoqlDiagnosticsService } from '../SoqlDiagnosticsService';

const text = (s: string): ChatEvent => ({ kind: 'text', text: s });

const validateCall = (soql: string, useToolingApi?: boolean): ChatEvent => ({
  kind: 'toolCall',
  call: {
    callId: 'c1',
    name: 'validate_soql',
    input: { soql, ...(useToolingApi === undefined ? {} : { useToolingApi }) },
  },
});

const answerWith = (soql: string, meta?: string) =>
  text(
    `Here you go.\n\n\`\`\`soql\n${soql}\n\`\`\`${meta ? `\n\`\`\`soql-meta\n${meta}\n\`\`\`` : ''}`,
  );

function makeAi(scripted: ChatEvent[][], runQuery = vi.fn(async () => ok())) {
  const gateway = new FakeGateway(scripted);
  const ai = createSoqlAi({
    gateway,
    connectionManager: { getCurrentOrg: () => null } as unknown as ConnectionManager,
    describeService: {} as DescribeService,
    queryService: { runQuery } as unknown as QueryService,
    diagnostics: { diagnose: vi.fn(async () => []) } as unknown as SoqlDiagnosticsService,
  });
  return { ai, gateway, runQuery };
}

const ok = () => ({ records: [{ Id: '001', Name: 'Acme' }], totalSize: 1, done: true });

describe('createSoqlAi', () => {
  it('offers validate_soql alongside the three shared org tools', async () => {
    const { ai, gateway } = makeAi([[text('hi')]]);
    await ai.generate({ question: 'anything' });
    expect(gateway.sends[0].tools.map((t) => t.name).sort()).toEqual([
      'describe_object',
      'get_current_user',
      'run_soql',
      'validate_soql',
    ]);
  });

  it('sends the preamble on the first turn only', async () => {
    const { ai, gateway } = makeAi([[text('a')], [text('b')]]);
    await ai.generate({ question: 'first' });
    await ai.generate({ question: 'second' });

    expect(gateway.sends[0].messages[0].text).toContain('## Request\nfirst');
    expect(gateway.sends[0].messages[0].text).toContain('validate_soql');
    const secondTurn = gateway.sends[1].messages;
    expect(secondTurn[secondTurn.length - 1].text).toBe('## Request\nsecond');
  });

  it('passes the last run through to the model', async () => {
    const { ai, gateway } = makeAi([[text('a')]]);
    await ai.generate({
      question: 'why is this empty?',
      lastRun: { records: [{ Id: '001', Amount: null }], totalSize: 1 },
    });
    expect(gateway.sends[0].messages[0].text).toContain("## The user's last run returned 1 row(s)");
    expect(gateway.sends[0].messages[0].text).toContain('Columns: Id, Amount');
  });

  it('carries the editor contents along on EVERY turn, not just the first', async () => {
    const { ai, gateway } = makeAi([[text('a')], [text('b')]]);
    await ai.generate({ question: 'first', currentQuery: 'SELECT Id FROM Account' });
    // The user edits the query between questions — the model must see the new one.
    await ai.generate({ question: 'second', currentQuery: 'SELECT Id, Name FROM Account' });

    expect(gateway.sends[0].messages[0].text).toContain('SELECT Id FROM Account');
    const secondTurn = gateway.sends[1].messages;
    expect(secondTurn[secondTurn.length - 1].text).toContain('SELECT Id, Name FROM Account');
  });

  it('takes useToolingApi from what actually ran, not the meta block', async () => {
    // The model validated against the Tooling API but forgot to say so in meta,
    // which would otherwise propose a metadata query on the Standard API.
    const query = 'SELECT Id, Name FROM ApexClass';
    const { ai } = makeAi([[validateCall(query, true)], [answerWith(query)]]);

    const result = await ai.generate({ question: 'apex classes' });

    expect(result.proposal).toEqual({ query, useToolingApi: true });
  });

  it('does not care how the proposal differs from the probe', async () => {
    // Reformatted and with the probe's LIMIT dropped — the API still holds,
    // because nothing here compares query text.
    const { ai } = makeAi([
      [validateCall('SELECT Id, Name FROM ApexClass LIMIT 20', true)],
      [answerWith('SELECT Id, Name\nFROM   ApexClass')],
    ]);
    const result = await ai.generate({ question: 'apex classes' });
    expect(result.proposal?.useToolingApi).toBe(true);
  });

  it('lets a repair loop settle on the API that finally worked', async () => {
    // Probed on Standard, rejected, retried on Tooling — the last one wins.
    const query = 'SELECT Id FROM ApexClass';
    const { ai } = makeAi([
      [validateCall(query)],
      [validateCall(query, true)],
      [answerWith(query)],
    ]);
    const result = await ai.generate({ question: 'apex classes' });
    expect(result.proposal?.useToolingApi).toBe(true);
  });

  it('falls back to the meta block when nothing was validated', async () => {
    const { ai } = makeAi([[answerWith('SELECT Id FROM ApexClass', '{"useToolingApi": true}')]]);
    const result = await ai.generate({ question: 'apex classes' });
    expect(result.proposal).toEqual({ query: 'SELECT Id FROM ApexClass', useToolingApi: true });
  });

  it("does not carry a previous turn's API into an unvalidated one", async () => {
    const { ai } = makeAi([
      [validateCall('SELECT Id FROM ApexClass', true)],
      [answerWith('SELECT Id FROM ApexClass')],
      [answerWith('SELECT Id FROM Account')],
    ]);

    await ai.generate({ question: 'apex classes' });
    const second = await ai.generate({ question: 'now accounts' });

    expect(second.proposal?.useToolingApi).toBe(false);
  });

  it('returns no proposal for a clarifying question', async () => {
    const { ai } = makeAi([[text('Did you mean the Account name or the account number?')]]);
    const result = await ai.generate({ question: 'acme stuff' });
    expect(result.proposal).toBeNull();
    expect(result.answer).toContain('Did you mean');
  });

  it('reset() clears the thread', async () => {
    const query = 'SELECT Id FROM ApexClass';
    const { ai, gateway } = makeAi([
      [validateCall(query, true)],
      [answerWith(query)],
      [answerWith(query)],
    ]);

    await ai.generate({ question: 'first' });
    ai.reset();
    await ai.generate({ question: 'again' });

    // A fresh thread: the preamble is sent again.
    expect(gateway.sends[2].messages).toHaveLength(1);
    expect(gateway.sends[2].messages[0].text).toContain('## Request\nagain');
    expect(gateway.sends[2].messages[0].text).toContain('validate_soql');
  });

  it('threads the abort signal into the validation probe', async () => {
    const runQuery = vi.fn(async () => ok());
    const { ai } = makeAi([[validateCall('SELECT Id FROM Account')], [text('done')]], runQuery);
    const controller = new AbortController();

    await ai.generate({ question: 'accounts' }, controller.signal);

    expect(runQuery).toHaveBeenCalledWith(
      'SELECT Id FROM Account LIMIT 1',
      false,
      controller.signal,
    );
  });
});

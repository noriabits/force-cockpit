import { describe, expect, it, vi } from 'vitest';
import type { ConnectionManager } from '../../../../../salesforce/connection';
import type { YamlScript } from '../../types';
import { AiExecutor } from './AiExecutor';
import type { ChatEvent, ChatRequest, LmGateway } from './types';

/** A scriptable LmGateway: each entry in `scripted` is the events for one send() call. */
class FakeGateway implements LmGateway {
  public readonly sends: ChatRequest[] = [];
  constructor(private readonly scripted: ChatEvent[][]) {}
  async listModels() {
    return [];
  }
  async *send(req: ChatRequest): AsyncIterable<ChatEvent> {
    // Snapshot the messages — AiExecutor mutates the same array across rounds.
    this.sends.push({
      modelId: req.modelId,
      tools: req.tools,
      messages: req.messages.map((m) => ({ ...m })),
    });
    for (const e of this.scripted[this.sends.length - 1] ?? []) yield e;
  }
}

function makeCM(overrides: Partial<ConnectionManager> = {}): ConnectionManager {
  return {
    query: vi.fn(async () => ({
      records: [{ Id: '001', Name: 'Acme' }],
      totalSize: 1,
      done: true,
    })),
    executeAnonymousWithDebugLog: vi.fn(async () => ({
      compiled: true,
      success: true,
      compileProblem: null,
      exceptionMessage: null,
      exceptionStackTrace: null,
      debugLog: '12:00:00.0 (1)|USER_DEBUG|[1]|DEBUG|payload-from-apex',
    })),
    getCurrentOrg: () => ({ username: 'u@example.com' }),
    ...overrides,
  } as unknown as ConnectionManager;
}

function aiScript(over: Partial<YamlScript> = {}): YamlScript {
  return {
    id: 'ai/x',
    folder: 'ai',
    name: 'X',
    description: '',
    type: 'ai',
    script: 'Analyse it.',
    source: 'user',
    gather: { kind: 'soql', value: 'SELECT Id FROM Account' },
    ...over,
  };
}

describe('AiExecutor', () => {
  it('runs a soql gather, embeds the data, and streams the analysis', async () => {
    const cm = makeCM();
    const gw = new FakeGateway([
      [
        { kind: 'text', text: 'Hello ' },
        { kind: 'text', text: 'world' },
      ],
    ]);
    const chunks: string[] = [];
    const result = await new AiExecutor(cm, gw).execute(aiScript(), undefined, (c) =>
      chunks.push(c),
    );

    expect(cm.query).toHaveBeenCalledWith('SELECT Id FROM Account');
    expect(result.success).toBe(true);
    expect(result.debugLog).toContain('Hello world');
    expect(chunks.join('')).toContain('Hello world');
    expect(gw.sends[0].messages[0].text).toContain('Acme'); // gather data in the prompt
    expect(gw.sends[0].tools).toEqual([]); // no follow-up tool by default
  });

  it('runs an apex gather and surfaces its debug output', async () => {
    const cm = makeCM();
    const gw = new FakeGateway([[{ kind: 'text', text: 'ok' }]]);
    const result = await new AiExecutor(cm, gw).execute(
      aiScript({ gather: { kind: 'apex', value: 'System.debug(1);' } }),
    );
    expect(cm.executeAnonymousWithDebugLog).toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(gw.sends[0].messages[0].text).toContain('payload-from-apex');
  });

  it('fails cleanly when the apex gather does not compile', async () => {
    const cm = makeCM({
      executeAnonymousWithDebugLog: vi.fn(async () => ({
        compiled: false,
        success: false,
        compileProblem: 'bad apex',
        exceptionMessage: null,
        exceptionStackTrace: null,
        debugLog: '',
      })),
    } as unknown as Partial<ConnectionManager>);
    const result = await new AiExecutor(cm, new FakeGateway([[]])).execute(
      aiScript({ gather: { kind: 'apex', value: 'x' } }),
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain('bad apex');
  });

  it('offers and runs the read-only run_soql tool when follow-up is allowed', async () => {
    const cm = makeCM();
    const gw = new FakeGateway([
      [
        {
          kind: 'toolCall',
          call: { callId: 'c1', name: 'run_soql', input: { soql: 'SELECT Id FROM Contact' } },
        },
      ],
      [{ kind: 'text', text: 'done' }],
    ]);
    const result = await new AiExecutor(cm, gw).execute(aiScript({ allowFollowupQueries: true }));

    expect(cm.query).toHaveBeenCalledTimes(2); // gather + follow-up
    expect(cm.query).toHaveBeenLastCalledWith('SELECT Id FROM Contact');
    expect(gw.sends[0].tools).toHaveLength(1);
    expect(gw.sends[0].tools[0].name).toBe('run_soql');
    const round2 = gw.sends[1].messages;
    expect(round2.some((m) => m.role === 'assistant' && 'toolCalls' in m && m.toolCalls)).toBe(
      true,
    );
    expect(round2.some((m) => m.role === 'toolResult' && m.callId === 'c1')).toBe(true);
    expect(result.success).toBe(true);
  });

  it('does not offer any tool when follow-up is disabled', async () => {
    const gw = new FakeGateway([[{ kind: 'text', text: 'x' }]]);
    await new AiExecutor(makeCM(), gw).execute(aiScript());
    expect(gw.sends[0].tools).toEqual([]);
  });

  it('blocks a non-SELECT follow-up query and feeds the rejection back', async () => {
    const cm = makeCM();
    const gw = new FakeGateway([
      [
        {
          kind: 'toolCall',
          call: { callId: 'c1', name: 'run_soql', input: { soql: 'DELETE FROM Account' } },
        },
      ],
      [{ kind: 'text', text: 'understood' }],
    ]);
    await new AiExecutor(cm, gw).execute(aiScript({ allowFollowupQueries: true }));

    expect(cm.query).toHaveBeenCalledTimes(1); // gather only — the DELETE never ran
    const toolResult = gw.sends[1].messages.find((m) => m.role === 'toolResult');
    expect(toolResult && 'content' in toolResult ? toolResult.content : '').toMatch(/read-only/i);
  });

  it('returns cancelled when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await new AiExecutor(makeCM(), new FakeGateway([[]])).execute(
      aiScript(),
      ac.signal,
    );
    expect(result.cancelled).toBe(true);
  });
});

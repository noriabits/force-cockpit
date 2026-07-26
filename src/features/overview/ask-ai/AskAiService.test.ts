import { describe, expect, it, vi } from 'vitest';
import type { ConnectionManager } from '../../../salesforce/connection';
import { DescribeService } from '../../../services/describe/DescribeService';
import {
  FakeGateway,
  fakeConnectionManager,
  fakeSkills,
  fakeWorkspaceSearch,
} from '../../../services/ai/__fixtures__/fakeGateway';
import type { ChatEvent, LmGateway } from '../../../services/ai/types';
import { AskAiService, type AskAiAccess } from './AskAiService';

function makeCM(overrides: Record<string, unknown> = {}): ConnectionManager {
  return fakeConnectionManager(overrides) as unknown as ConnectionManager;
}

function makeService(
  gw: LmGateway,
  opts: {
    cm?: ConnectionManager;
    skills?: ReturnType<typeof fakeSkills>;
    workspaceSearch?: ReturnType<typeof fakeWorkspaceSearch>;
  } = {},
): AskAiService {
  const cm = opts.cm ?? makeCM();
  return new AskAiService(
    gw,
    cm,
    new DescribeService(cm),
    opts.skills ?? fakeSkills(),
    opts.workspaceSearch,
  );
}

const ALL_ON: AskAiAccess = { allowWorkspaceFiles: true, allowOrgQueries: true };
const ALL_OFF: AskAiAccess = { allowWorkspaceFiles: false, allowOrgQueries: false };

describe('AskAiService', () => {
  it('sends the preamble only on the first turn', async () => {
    const gw = new FakeGateway([
      [{ kind: 'text', text: 'first' }],
      [{ kind: 'text', text: 'second' }],
    ]);
    const svc = makeService(gw);

    await svc.ask({ question: 'How many accounts?', access: ALL_ON });
    await svc.ask({ question: 'And contacts?', access: ALL_ON });

    expect(gw.sends[0].messages[0].text).toContain('You are a Salesforce assistant');
    expect(gw.sends[0].messages[0].text).toContain('## Question\nHow many accounts?');
    // Turn 2's newest user message is the bare follow-up — no preamble repeated.
    const round2Messages = gw.sends[1].messages;
    const lastUser = [...round2Messages].reverse().find((m) => m.role === 'user');
    expect(lastUser?.text).toBe('And contacts?');
    expect(lastUser?.text).not.toContain('You are a Salesforce assistant');
  });

  it('keeps the conversation continuous — turn 2 carries turn 1 history', async () => {
    const gw = new FakeGateway([
      [{ kind: 'text', text: 'first' }],
      [{ kind: 'text', text: 'second' }],
    ]);
    const svc = makeService(gw);

    await svc.ask({ question: 'Q1', access: ALL_ON });
    await svc.ask({ question: 'Q2', access: ALL_ON });

    expect(svc.turnCount).toBe(2);
    const round2 = gw.sends[1].messages;
    expect(round2.some((m) => m.role === 'assistant' && m.text === 'first')).toBe(true);
  });

  it('rolls back a cancelled turn so the next ask() has no dangling tool calls', async () => {
    const ac = new AbortController();
    // The tool call proposed in round 1 triggers a run_soql query that aborts
    // and then hangs — the cancel lands mid-tool-execution, exactly the gap
    // between AiConversation pushing the assistant turn (with its toolCalls)
    // and pushing the matching toolResult.
    const queryMock = vi.fn().mockImplementationOnce(() => {
      ac.abort();
      return new Promise(() => {});
    });
    const cm = makeCM({ query: queryMock });
    // Round 1 (consumed by the cancelled turn) proposes the tool call; round 2
    // (consumed by the retry, since AiConversation never got that far the
    // first time) is a plain text answer — the retry's fresh question doesn't
    // trigger another tool call in this script.
    const gw = new FakeGateway([
      [
        {
          kind: 'toolCall',
          call: { callId: 'c1', name: 'run_soql', input: { soql: 'SELECT Id FROM Contact' } },
        },
      ],
      [{ kind: 'text', text: 'done' }],
    ]);
    const svc = makeService(gw, { cm });

    const result = await svc.ask({ question: 'Query contacts', access: ALL_ON }, ac.signal);
    expect(result.cancelled).toBe(true);
    expect(gw.sends).toHaveLength(1); // never reached round 2 the first time

    // The retry (same service instance — proves internal rollback, not just a
    // fresh service) must succeed cleanly and send the preamble again, since
    // the rollback restored the thread to empty.
    const retry = await svc.ask({ question: 'Query contacts again', access: ALL_ON });
    expect(retry.cancelled).toBeFalsy();

    const sentMessages = gw.sends[1].messages;
    expect(sentMessages).toHaveLength(1); // only the fresh user message — no leftover turns
    for (const m of sentMessages) {
      if (m.role === 'assistant' && m.toolCalls?.length) {
        for (const call of m.toolCalls) {
          expect(
            sentMessages.some((r) => r.role === 'toolResult' && r.callId === call.callId),
          ).toBe(true);
        }
      }
    }
    expect(sentMessages[0].text).toContain('You are a Salesforce assistant');
  });

  it('rolls back on a thrown error too', async () => {
    let calls = 0;
    const gw: LmGateway = {
      listModels: async () => [],
      async *send(): AsyncIterable<ChatEvent> {
        calls++;
        if (calls === 1) throw new Error('boom');
        yield { kind: 'text', text: 'ok' };
      },
    };
    const svc = makeService(gw);
    await expect(svc.ask({ question: 'Q1', access: ALL_ON })).rejects.toThrow('boom');
    expect(svc.turnCount).toBe(0);

    // The thread is back to empty — the next successful turn sends the preamble.
    await svc.ask({ question: 'Q1 again', access: ALL_ON });
    expect(svc.turnCount).toBe(1);
  });

  it('gates tools by the toggles: both off leaves no org/workspace tools', async () => {
    const gw = new FakeGateway([[{ kind: 'text', text: 'ok' }]]);
    const svc = makeService(gw);
    await svc.ask({ question: 'hi', access: ALL_OFF });
    const names = gw.sends[0].tools.map((t) => t.name);
    expect(names).not.toContain('describe_object');
    expect(names).not.toContain('run_soql');
    expect(names).not.toContain('get_current_user');
    expect(names).not.toContain('search_workspace_files');
    expect(names).not.toContain('read_workspace_file');
  });

  it('offers org tools (incl. get_current_user) when allowOrgQueries is on', async () => {
    const gw = new FakeGateway([[{ kind: 'text', text: 'ok' }]]);
    const svc = makeService(gw);
    await svc.ask({
      question: 'hi',
      access: { allowWorkspaceFiles: false, allowOrgQueries: true },
    });
    const names = gw.sends[0].tools.map((t) => t.name);
    expect(names).toContain('describe_object');
    expect(names).toContain('run_soql');
    expect(names).toContain('get_current_user');
  });

  it('does not offer workspace tools when the flag is on but no WorkspaceSearch is injected', async () => {
    const gw = new FakeGateway([[{ kind: 'text', text: 'ok' }]]);
    const svc = makeService(gw); // no workspaceSearch injected
    await svc.ask({
      question: 'hi',
      access: { allowWorkspaceFiles: true, allowOrgQueries: false },
    });
    const names = gw.sends[0].tools.map((t) => t.name);
    expect(names).not.toContain('search_workspace_files');
    expect(names).not.toContain('read_workspace_file');
  });

  it('offers workspace tools when the flag is on and a WorkspaceSearch is injected', async () => {
    const gw = new FakeGateway([[{ kind: 'text', text: 'ok' }]]);
    const svc = makeService(gw, { workspaceSearch: fakeWorkspaceSearch() });
    await svc.ask({
      question: 'hi',
      access: { allowWorkspaceFiles: true, allowOrgQueries: false },
    });
    const names = gw.sends[0].tools.map((t) => t.name);
    expect(names).toContain('search_workspace_files');
    expect(names).toContain('read_workspace_file');
  });

  it('locks the tool set after the first turn — later toggles are ignored', async () => {
    const gw = new FakeGateway([[{ kind: 'text', text: 'a' }], [{ kind: 'text', text: 'b' }]]);
    const svc = makeService(gw);

    await svc.ask({
      question: 'Q1',
      access: { allowWorkspaceFiles: false, allowOrgQueries: true },
    });
    const result2 = await svc.ask({
      question: 'Q2',
      access: { allowWorkspaceFiles: false, allowOrgQueries: false }, // trying to turn it off
    });

    const names = gw.sends[1].tools.map((t) => t.name);
    expect(names).toContain('run_soql'); // still declared — locked from turn 1
    expect(result2.access.allowOrgQueries).toBe(true); // effective access reflects the lock
  });

  it('always injects the skills catalogue and read_skill with no picker', async () => {
    const skills = fakeSkills([
      { id: 'dq', name: 'Data Quality', description: 'check completeness' },
    ]);
    const gw = new FakeGateway([[{ kind: 'text', text: 'ok' }]]);
    const svc = makeService(gw, { skills });
    await svc.ask({ question: 'hi', access: ALL_OFF });

    expect(gw.sends[0].messages[0].text).toContain('## Available skills');
    expect(gw.sends[0].messages[0].text).toContain('dq: check completeness');
    expect(gw.sends[0].tools.map((t) => t.name)).toContain('read_skill');
  });

  it('omits the skills catalogue when none exist', async () => {
    const gw = new FakeGateway([[{ kind: 'text', text: 'ok' }]]);
    const svc = makeService(gw, { skills: fakeSkills([]) });
    await svc.ask({ question: 'hi', access: ALL_OFF });

    expect(gw.sends[0].messages[0].text).not.toContain('## Available skills');
    expect(gw.sends[0].tools.map((t) => t.name)).not.toContain('read_skill');
  });

  it('a skill added mid-conversation does not change the already-locked tool set', async () => {
    const list: Array<{ id: string; name: string; description: string }> = [];
    const skills = {
      listSkills: () => list,
      readSkill: () => null,
    } as unknown as ReturnType<typeof fakeSkills>;
    const gw = new FakeGateway([[{ kind: 'text', text: 'a' }], [{ kind: 'text', text: 'b' }]]);
    const svc = makeService(gw, { skills });

    await svc.ask({ question: 'Q1', access: ALL_OFF }); // no skills yet → hasSkills locked false
    list.push({ id: 'late', name: 'Late', description: 'added after turn 1' });
    await svc.ask({ question: 'Q2', access: ALL_OFF });

    expect(gw.sends[1].tools.map((t) => t.name)).not.toContain('read_skill');
    expect(
      gw.sends[1].messages.every((m) => !('text' in m) || !m.text.includes('## Available skills')),
    ).toBe(true);
  });

  it('rejects a second concurrent ask() while one is running', async () => {
    let resolveSend!: () => void;
    const gw: LmGateway = {
      listModels: async () => [],
      async *send(): AsyncIterable<ChatEvent> {
        await new Promise<void>((resolve) => {
          resolveSend = resolve;
        });
        yield { kind: 'text', text: 'done' };
      },
    };
    const svc = makeService(gw);
    const first = svc.ask({ question: 'Q1', access: ALL_ON });
    await expect(svc.ask({ question: 'Q2', access: ALL_ON })).rejects.toThrow(
      'Another question is still running.',
    );
    resolveSend();
    await first;
  });

  it('reset() restores first-turn behaviour', async () => {
    const gw = new FakeGateway([[{ kind: 'text', text: 'a' }], [{ kind: 'text', text: 'b' }]]);
    const svc = makeService(gw);
    await svc.ask({ question: 'Q1', access: ALL_ON });
    svc.reset();
    expect(svc.turnCount).toBe(0);
    await svc.ask({ question: 'Q2', access: ALL_OFF });
    expect(gw.sends[1].messages[0].text).toContain('You are a Salesforce assistant');
    expect(gw.sends[1].tools.map((t) => t.name)).not.toContain('run_soql');
  });

  it('getSnapshot() is null before any turn has landed', () => {
    const gw = new FakeGateway([[{ kind: 'text', text: 'ok' }]]);
    const svc = makeService(gw);
    expect(svc.getSnapshot()).toBeNull();
  });

  it('getSnapshot() returns the thread, lock, turns and modelId after a turn', async () => {
    const gw = new FakeGateway([[{ kind: 'text', text: 'ok' }]]);
    const svc = makeService(gw, { workspaceSearch: fakeWorkspaceSearch() });
    await svc.ask({ question: 'Q1', modelId: 'gpt-4o', access: ALL_ON });

    const snapshot = svc.getSnapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot?.turns).toBe(1);
    expect(snapshot?.modelId).toBe('gpt-4o');
    expect(snapshot?.locked).toEqual({
      allowWorkspaceFiles: true,
      allowOrgQueries: true,
      hasSkills: false,
    });
    expect(snapshot?.messages).toHaveLength(2); // user + assistant
  });

  it('restoreSnapshot() throws while a question is running', async () => {
    let resolveSend!: () => void;
    const gw: LmGateway = {
      listModels: async () => [],
      async *send(): AsyncIterable<ChatEvent> {
        await new Promise<void>((resolve) => {
          resolveSend = resolve;
        });
        yield { kind: 'text', text: 'done' };
      },
    };
    const svc = makeService(gw);
    const first = svc.ask({ question: 'Q1', access: ALL_ON });
    expect(() =>
      svc.restoreSnapshot({ messages: [], locked: null, turns: 0, modelId: '' }),
    ).toThrow('Cannot restore a conversation while one is running.');
    resolveSend();
    await first;
  });

  it('restoreSnapshot() resumes a thread without repeating the preamble and keeps its lock', async () => {
    const gw = new FakeGateway([[{ kind: 'text', text: 'resumed answer' }]]);
    const svc = makeService(gw);

    // Simulate a snapshot that was archived with workspace files OFF, org queries ON.
    const restored = {
      messages: [
        { role: 'user' as const, text: '## Question\nWhat is the API version?' },
        { role: 'assistant' as const, text: 'It is 65.0.' },
      ],
      locked: { allowWorkspaceFiles: false, allowOrgQueries: true, hasSkills: false },
      turns: 1,
      modelId: 'gpt-4o',
    };
    svc.restoreSnapshot(restored);
    expect(svc.turnCount).toBe(1);

    // A follow-up asks with different toggles — the restored lock should win.
    const result = await svc.ask({
      question: 'And the API name?',
      access: { allowWorkspaceFiles: true, allowOrgQueries: false },
    });

    expect(result.access).toEqual({ allowWorkspaceFiles: false, allowOrgQueries: true });
    const sent = gw.sends[0].messages;
    expect(sent).toHaveLength(3); // 2 restored + 1 new user message
    expect(sent[2].text).toBe('And the API name?'); // no preamble repeated
    const names = gw.sends[0].tools.map((t) => t.name);
    expect(names).toContain('run_soql'); // org tools still locked on
    expect(names).not.toContain('search_workspace_files'); // workspace tools still locked off
  });

  it('surfaces a model fallback once', async () => {
    const gw = new FakeGateway([
      [
        { kind: 'modelFallback', requestedId: 'gpt-4o', usedModelName: 'Claude Sonnet 4.6' },
        { kind: 'text', text: 'ok' },
      ],
    ]);
    const svc = makeService(gw);
    const fallbacks: Array<{ requestedId: string; usedModelName: string }> = [];
    const result = await svc.ask(
      { question: 'hi', modelId: 'gpt-4o', access: ALL_ON },
      undefined,
      undefined,
      (fb) => fallbacks.push(fb),
    );
    expect(result.modelFallback).toEqual({
      requestedId: 'gpt-4o',
      usedModelName: 'Claude Sonnet 4.6',
    });
    expect(fallbacks).toEqual([{ requestedId: 'gpt-4o', usedModelName: 'Claude Sonnet 4.6' }]);
  });
});

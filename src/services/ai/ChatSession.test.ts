// Direct coverage of the generic multi-turn contract extracted out of
// AskAiService. AskAiService.test.ts still exercises the same behaviours end to
// end through the wrapper; these tests pin the contract the SOQL panel now also
// depends on, without going through anyone's access toggles.
import { describe, expect, it, vi } from 'vitest';
import { ChatSession } from './ChatSession';
import { FakeGateway } from './__fixtures__/fakeGateway';
import type { ChatEvent } from './types';
import type { ToolHandler } from './tools/ToolHandler';

const text = (s: string): ChatEvent => ({ kind: 'text', text: s });

describe('ChatSession', () => {
  it('prepends the first-message prefix on turn 1 only', async () => {
    const gateway = new FakeGateway([[text('one')], [text('two')]]);
    const session = new ChatSession(gateway);

    await session.ask({ question: 'first', tools: [], firstMessagePrefix: 'PREAMBLE\n\n' });
    await session.ask({ question: 'second', tools: [], firstMessagePrefix: 'PREAMBLE\n\n' });

    expect(gateway.sends[0].messages[0]).toEqual({ role: 'user', text: 'PREAMBLE\n\nfirst' });
    // Turn 2 replays the thread; the new question is the last message, bare.
    const secondTurn = gateway.sends[1].messages;
    expect(secondTurn[secondTurn.length - 1]).toEqual({ role: 'user', text: 'second' });
  });

  it('keeps the thread alive across turns', async () => {
    const gateway = new FakeGateway([[text('a')], [text('b')]]);
    const session = new ChatSession(gateway);

    await session.ask({ question: 'first', tools: [] });
    const result = await session.ask({ question: 'second', tools: [] });

    expect(result.turnIndex).toBe(1);
    expect(session.turnCount).toBe(2);
    // user, assistant, user — the second send replays the whole thread.
    expect(gateway.sends[1].messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('streams chunks through onChunk and returns the joined answer', async () => {
    const gateway = new FakeGateway([[text('he'), text('llo')]]);
    const session = new ChatSession(gateway);
    const chunks: string[] = [];

    const result = await session.ask({ question: 'q', tools: [] }, undefined, (c) =>
      chunks.push(c),
    );

    expect(chunks).toEqual(['he', 'llo']);
    expect(result.answer).toBe('hello');
  });

  it('rejects a second concurrent ask', async () => {
    const gateway = new FakeGateway([[text('a')]]);
    const session = new ChatSession(gateway);
    const inFlight = session.ask({ question: 'q', tools: [] });

    await expect(session.ask({ question: 'other', tools: [] })).rejects.toThrow(
      'Another question is still running.',
    );
    await inFlight;
  });

  describe('cancellation rollback', () => {
    /**
     * The trap this guards: AiConversation pushes the assistant turn (with its
     * toolCalls) BEFORE running the tools it proposed. A cancel in between
     * would leave a dangling toolCalls entry with no matching toolResult, and
     * the language model API rejects that on the next turn.
     */
    const hangingTool = (controller: AbortController): ToolHandler => ({
      spec: { name: 'slow_tool', description: 'hangs', inputSchema: { type: 'object' } },
      run: () =>
        new Promise<string>(() => {
          controller.abort(); // cancel while the tool is still "running"
        }),
    });

    it('leaves the thread untouched when the FIRST turn is cancelled', async () => {
      const controller = new AbortController();
      const gateway = new FakeGateway([
        [{ kind: 'toolCall', call: { callId: 'c1', name: 'slow_tool', input: {} } }],
        [text('recovered')],
      ]);
      const session = new ChatSession(gateway);

      const cancelled = await session.ask(
        { question: 'first', tools: [hangingTool(controller)], firstMessagePrefix: 'PREAMBLE\n\n' },
        controller.signal,
      );

      expect(cancelled.cancelled).toBe(true);
      expect(session.turnCount).toBe(0);
      expect(session.getSnapshot()).toBeNull();

      // The retry is a clean first turn — the preamble is sent again, and no
      // orphaned assistant/toolCall turn survives from the cancelled attempt.
      await session.ask({ question: 'retry', tools: [], firstMessagePrefix: 'PREAMBLE\n\n' });
      expect(gateway.sends[1].messages).toEqual([{ role: 'user', text: 'PREAMBLE\n\nretry' }]);
    });

    it('rolls back to the previously committed thread when a LATER turn is cancelled', async () => {
      const controller = new AbortController();
      const gateway = new FakeGateway([
        [text('first answer')],
        [{ kind: 'toolCall', call: { callId: 'c1', name: 'slow_tool', input: {} } }],
        [text('third')],
      ]);
      const session = new ChatSession(gateway);

      await session.ask({ question: 'first', tools: [] });
      await session.ask(
        { question: 'second', tools: [hangingTool(controller)] },
        controller.signal,
      );

      expect(session.turnCount).toBe(1);
      await session.ask({ question: 'third', tools: [] });
      // The cancelled turn left nothing behind: user/assistant from turn 1, then turn 3.
      expect(gateway.sends[2].messages.map((m) => m.text)).toEqual([
        'first',
        'first answer',
        'third',
      ]);
    });

    it('rethrows a genuine error but still rolls the turn back', async () => {
      const gateway = new FakeGateway([[text('a')]]);
      vi.spyOn(gateway, 'send').mockImplementationOnce(() => {
        throw new Error('Language model error: boom');
      });
      const session = new ChatSession(gateway);

      await expect(session.ask({ question: 'q', tools: [] })).rejects.toThrow('boom');
      expect(session.turnCount).toBe(0);
      expect(session.getSnapshot()).toBeNull();
    });
  });

  describe('snapshots', () => {
    it('returns null before any turn lands, then the live thread', async () => {
      const gateway = new FakeGateway([[text('a')]]);
      const session = new ChatSession(gateway);
      expect(session.getSnapshot()).toBeNull();

      await session.ask({ question: 'q', tools: [], modelId: 'gpt-x' });

      expect(session.getSnapshot()).toMatchObject({ turns: 1, modelId: 'gpt-x' });
    });

    it('restores a thread so the next turn continues it', async () => {
      const gateway = new FakeGateway([[text('resumed')]]);
      const session = new ChatSession(gateway);

      session.restoreSnapshot({
        messages: [
          { role: 'user', text: 'earlier' },
          { role: 'assistant', text: 'earlier answer' },
        ],
        turns: 1,
        modelId: 'gpt-x',
      });
      await session.ask({ question: 'follow-up', tools: [] });

      expect(gateway.sends[0].messages.map((m) => m.text)).toEqual([
        'earlier',
        'earlier answer',
        'follow-up',
      ]);
    });

    it('reset() clears the thread so the preamble is sent again', async () => {
      const gateway = new FakeGateway([[text('a')], [text('b')]]);
      const session = new ChatSession(gateway);

      await session.ask({ question: 'first', tools: [], firstMessagePrefix: 'PREAMBLE\n\n' });
      session.reset();
      await session.ask({ question: 'after reset', tools: [], firstMessagePrefix: 'PREAMBLE\n\n' });

      expect(session.turnCount).toBe(1);
      expect(gateway.sends[1].messages).toEqual([
        { role: 'user', text: 'PREAMBLE\n\nafter reset' },
      ]);
    });
  });
});

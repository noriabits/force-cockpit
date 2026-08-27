// Covers the ChatMessage → vscode.LanguageModelChatMessage mapping, which is
// the only logic in the gateway that is not a straight pass-through — and the
// one place where Copilot's "Auto" model imposes a shape requirement of its own
// (see TOOL_RESULT_NOTE in LmGateway.ts).
import { beforeEach, describe, expect, it, vi } from 'vitest';

type SentMessage = { role: 'user' | 'assistant'; content: unknown };

const stub = vi.hoisted(() => ({
  /** Messages the gateway handed to `model.sendRequest` on the last call. */
  sent: [] as SentMessage[],
}));

vi.mock('vscode', () => {
  class TextPart {
    constructor(readonly value: string) {}
  }
  class ToolCallPart {
    constructor(
      readonly callId: string,
      readonly name: string,
      readonly input: object,
    ) {}
  }
  class ToolResultPart {
    constructor(
      readonly callId: string,
      readonly content: unknown[],
    ) {}
  }
  const model = {
    id: 'auto',
    vendor: 'copilot',
    family: 'auto',
    name: 'Auto',
    maxInputTokens: 1000,
    sendRequest: (messages: SentMessage[]) => {
      stub.sent = messages;
      return { stream: (async function* () {})() };
    },
  };
  return {
    lm: { selectChatModels: async () => [model] },
    LanguageModelTextPart: TextPart,
    LanguageModelToolCallPart: ToolCallPart,
    LanguageModelToolResultPart: ToolResultPart,
    LanguageModelError: class extends Error {},
    CancellationTokenSource: class {
      token = {};
      cancel() {}
      dispose() {}
    },
    LanguageModelChatMessage: {
      User: (content: unknown) => ({ role: 'user' as const, content }),
      Assistant: (content: unknown) => ({ role: 'assistant' as const, content }),
    },
  };
});

import * as vscode from 'vscode';
import { VsCodeLmGateway } from './LmGateway';
import type { ChatMessage } from './types';

/** Drive a request through the gateway and return what VS Code was sent. */
async function sendAndCapture(messages: ChatMessage[]): Promise<SentMessage[]> {
  // Drain the (empty) stub stream; only the request side matters here.
  const gateway = new VsCodeLmGateway();
  for await (const event of gateway.send({ messages, tools: [] })) void event;
  return stub.sent;
}

const partsOf = (msg: SentMessage) => msg.content as unknown[];

describe('VsCodeLmGateway message mapping', () => {
  beforeEach(() => {
    stub.sent = [];
  });

  it('sends a user turn as plain text', async () => {
    const [msg] = await sendAndCapture([{ role: 'user', text: 'list my accounts' }]);
    expect(msg).toEqual({ role: 'user', content: 'list my accounts' });
  });

  it('keeps a tool result message text-bearing, so Auto has a prompt to route on', async () => {
    const [, , toolResult] = await sendAndCapture([
      { role: 'user', text: 'list my accounts' },
      { role: 'assistant', text: '', toolCalls: [{ callId: 'c1', name: 'run_soql', input: {} }] },
      { role: 'toolResult', callId: 'c1', content: '{"rows":[]}' },
    ]);

    const parts = partsOf(toolResult);
    expect(parts[0]).toBeInstanceOf(vscode.LanguageModelToolResultPart);
    // The part Copilot's auto-router reads: without it the request is refused
    // with "Auto mode needs a prompt or a command to route a request".
    expect(parts[1]).toBeInstanceOf(vscode.LanguageModelTextPart);
    expect((parts[1] as vscode.LanguageModelTextPart).value.trim()).not.toBe('');
  });

  it('carries the note on every tool result, so a resent prefix stays identical', async () => {
    const [, , first, second] = await sendAndCapture([
      { role: 'user', text: 'list my accounts' },
      {
        role: 'assistant',
        text: '',
        toolCalls: [
          { callId: 'c1', name: 'describe_object', input: {} },
          { callId: 'c2', name: 'run_soql', input: {} },
        ],
      },
      { role: 'toolResult', callId: 'c1', content: 'fields' },
      { role: 'toolResult', callId: 'c2', content: 'rows' },
    ]);

    const noteOf = (m: SentMessage) => (partsOf(m)[1] as vscode.LanguageModelTextPart).value;
    expect(noteOf(first)).toBe(noteOf(second));
  });
});

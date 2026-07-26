import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../../services/ai/types';
import { buildAskAiPreamble } from './prompt';
import { deriveTitleFromMessages, reconstructTranscript } from './reconstructTranscript';

// The turn-0 user message always carries the real preamble produced by
// buildAskAiPreamble — exercising against it (not a hand-written fixture)
// means a future edit to prompt.ts's marker wording trips this test instead
// of silently breaking title/transcript reconstruction.
function turnZeroText(question: string): string {
  const preamble = buildAskAiPreamble({ hasWorkspaceTools: true, hasOrgTools: true });
  return `${preamble}\n\n## Question\n${question}`;
}

describe('deriveTitleFromMessages', () => {
  it('strips the preamble and returns the first question', () => {
    const messages: ChatMessage[] = [
      { role: 'user', text: turnZeroText('How many accounts do we have?') },
      { role: 'assistant', text: '42' },
    ];
    expect(deriveTitleFromMessages(messages)).toBe('How many accounts do we have?');
  });

  it('truncates a long question to 60 chars with an ellipsis', () => {
    const long = 'a'.repeat(100);
    const messages: ChatMessage[] = [{ role: 'user', text: turnZeroText(long) }];
    const title = deriveTitleFromMessages(messages);
    expect(title.endsWith('…')).toBe(true);
    expect(title.length).toBe(61); // 60 chars + ellipsis
  });

  it('collapses internal whitespace/newlines', () => {
    const messages: ChatMessage[] = [{ role: 'user', text: turnZeroText('Line one\n  Line two') }];
    expect(deriveTitleFromMessages(messages)).toBe('Line one Line two');
  });

  it('returns a fallback title when there are no user messages', () => {
    expect(deriveTitleFromMessages([])).toBe('Conversation');
    expect(deriveTitleFromMessages([{ role: 'assistant', text: 'hi' }])).toBe('Conversation');
  });
});

describe('reconstructTranscript', () => {
  it('rebuilds a single-turn transcript, stripping the preamble', () => {
    const messages: ChatMessage[] = [
      { role: 'user', text: turnZeroText('How many accounts?') },
      { role: 'assistant', text: '42' },
    ];
    expect(reconstructTranscript(messages)).toBe('## You\nHow many accounts?\n\n## Assistant\n42');
  });

  it('joins multiple turns with the same separator the live webview uses', () => {
    const messages: ChatMessage[] = [
      { role: 'user', text: turnZeroText('Q1') },
      { role: 'assistant', text: 'A1' },
      { role: 'user', text: 'Q2' },
      { role: 'assistant', text: 'A2' },
    ];
    expect(reconstructTranscript(messages)).toBe(
      '## You\nQ1\n\n## Assistant\nA1\n\n---\n\n## You\nQ2\n\n## Assistant\nA2',
    );
  });

  it('concatenates multiple assistant entries within one turn (tool-call rounds)', () => {
    const messages: ChatMessage[] = [
      { role: 'user', text: turnZeroText('Look this up') },
      {
        role: 'assistant',
        text: 'Let me check.',
        toolCalls: [{ callId: 'c1', name: 'run_soql', input: { soql: 'SELECT Id FROM Account' } }],
      },
      { role: 'toolResult', callId: 'c1', content: '[]' },
      { role: 'assistant', text: ' No accounts found.' },
    ];
    expect(reconstructTranscript(messages)).toBe(
      '## You\nLook this up\n\n## Assistant\nLet me check. No accounts found.',
    );
  });

  it('returns an empty string for an empty thread', () => {
    expect(reconstructTranscript([])).toBe('');
  });
});

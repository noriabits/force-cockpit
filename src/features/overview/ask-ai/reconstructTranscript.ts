// Host-side reconstruction of a display transcript + title from the raw
// ChatMessage[] thread. index.ts calls this after every completed reply to
// save the live conversation to history, so it needs to work from the raw
// thread alone rather than round-tripping to the webview for its own copy of
// the transcript on every single turn.
import type { ChatMessage } from '../../../services/ai/types';

const QUESTION_MARKER = '\n\n## Question\n';
const TITLE_MAX_LENGTH = 60;

/** Strips the turn-0 preamble/skills-catalogue prefix baked in by AskAiService.ask(), if present. */
function stripPreamble(text: string): string {
  const idx = text.indexOf(QUESTION_MARKER);
  return idx === -1 ? text : text.slice(idx + QUESTION_MARKER.length);
}

function truncate(text: string, maxLength: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > maxLength ? oneLine.slice(0, maxLength) + '…' : oneLine;
}

function isUserMessage(m: ChatMessage): m is Extract<ChatMessage, { role: 'user' }> {
  return m.role === 'user';
}

/** The first question asked, truncated — used as the archived conversation's title. */
export function deriveTitleFromMessages(messages: ChatMessage[]): string {
  const first = messages.find(isUserMessage);
  if (!first) return 'Conversation';
  return truncate(stripPreamble(first.text), TITLE_MAX_LENGTH) || 'Conversation';
}

/**
 * Rebuilds the "## You / ## Assistant" display transcript the webview would
 * have shown live, from the raw thread. A single visible turn can span
 * several raw assistant/toolResult entries (one per tool-call round), so all
 * assistant text between one user message and the next is concatenated —
 * toolResult entries carry no display text of their own, matching how the
 * live webview transcript never rendered tool-progress notes either.
 */
export function reconstructTranscript(messages: ChatMessage[]): string {
  const blocks: string[] = [];
  let question: string | null = null;
  let answer = '';
  let isFirstTurn = true;

  const flush = () => {
    if (question === null) return;
    blocks.push(`## You\n${question}\n\n## Assistant\n${answer}`);
    question = null;
    answer = '';
  };

  for (const message of messages) {
    if (message.role === 'user') {
      flush();
      question = isFirstTurn ? stripPreamble(message.text) : message.text;
      isFirstTurn = false;
    } else if (message.role === 'assistant') {
      answer += message.text;
    }
  }
  flush();

  return blocks.join('\n\n---\n\n');
}

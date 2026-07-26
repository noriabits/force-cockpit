/**
 * Auto-capitalizes SOQL keywords as the user finishes typing them — SELECT, FROM,
 * WHERE, AND, LIKE, ORDER, BY... the Salesforce documentation convention. Pure and
 * DOM-free; index.js calls it on the textarea's `input`/`blur` events and applies
 * the replacement via `textarea.setRangeText` (undo-stack friendly, no full
 * re-render). Unit-tested directly.
 */

import { SOQL_CLAUSE_WORDS, SOQL_OPERATOR_WORDS } from './soql-keywords';

const KEYWORD_WORDS = new Set(
  [...SOQL_CLAUSE_WORDS, ...SOQL_OPERATOR_WORDS].map((w) => w.toLowerCase()),
);

export interface KeywordCapitalization {
  start: number;
  end: number;
  /** Always equal to `word.toUpperCase()` — provided so the caller need not recompute it. */
  word: string;
}

/** The run of letters ending at `end` (exclusive), and where it starts. */
function wordEndingAt(text: string, end: number): { start: number; word: string } {
  let start = end;
  while (start > 0 && /[A-Za-z]/.test(text[start - 1])) start--;
  return { start, word: text.slice(start, end) };
}

/** Index right after the nearest non-whitespace character before `index`. */
function skipWhitespaceBack(text: string, index: number): number {
  let i = index;
  while (i > 0 && /\s/.test(text[i - 1])) i--;
  return i;
}

/**
 * Whether the word ending right before `boundaryIndex` — a delimiter the user
 * just typed (space, comma, parenthesis…), or `text.length` at blur — should be
 * uppercased, and if so, the edit to make.
 *
 * Returns null when there's nothing to do: no word there, not a recognised
 * keyword, already uppercase, or — the one deliberate exception — it sits in the
 * FROM object-name slot. `Order` and `Group` are real standard Salesforce
 * objects, not the ORDER/GROUP clause keywords; capitalizing `FROM Order` would
 * silently rewrite the object name the user typed.
 */
export function capitalizeKeywordEndingAt(
  text: string,
  boundaryIndex: number,
): KeywordCapitalization | null {
  const { start, word } = wordEndingAt(text, boundaryIndex);
  if (!word) return null;

  const upper = word.toUpperCase();
  if (upper === word) return null;
  if (!KEYWORD_WORDS.has(word.toLowerCase())) return null;

  const { word: prevWord } = wordEndingAt(text, skipWhitespaceBack(text, start));
  if (prevWord.toLowerCase() === 'from') return null;

  return { start, end: boundaryIndex, word: upper };
}

/**
 * Pure SOQL tokenizer for the SOQL tab editor's highlight overlay. Scans the
 * query left to right and returns a gap-free, non-overlapping list of tokens that
 * covers the whole input, so the renderer can just concatenate them without any
 * index arithmetic of its own.
 *
 * DOM-free and dependency-free so it can be unit-tested directly. It must never
 * throw: the overlay renders the text the user is actually typing, and a throw
 * there would leave the (transparent) textarea looking empty.
 */

import {
  SOQL_CLAUSE_WORDS,
  SOQL_FUNCTIONS,
  SOQL_LITERAL_WORDS,
  SOQL_OPERATOR_WORDS,
} from '../soql-keywords';

export type TokenKind = 'keyword' | 'function' | 'string' | 'number' | 'operator' | 'text';

export interface SoqlToken {
  start: number;
  end: number;
  kind: TokenKind;
}

/** Past this size, highlighting stops earning its keystroke cost. */
export const MAX_HIGHLIGHT_CHARS = 20_000;

const lower = (words: string[]) => new Set(words.map((w) => w.toLowerCase()));

const KEYWORDS = lower([...SOQL_CLAUSE_WORDS, ...SOQL_OPERATOR_WORDS]);
const FUNCTIONS = lower(SOQL_FUNCTIONS);
const LITERALS = lower(SOQL_LITERAL_WORDS);

const IDENT_CHAR = /[A-Za-z0-9_]/;
// Comparison symbols only. Commas, parens and dots stay plain — colouring them
// makes a normal SELECT list look like noise.
const OPERATOR_CHAR = /[=<>!]/;

/**
 * Classify an identifier run. `prevWord` is the identifier immediately before it
 * (ignoring whitespace/punctuation), lowercased. Unknown words (fields, objects)
 * stay plain text.
 */
function wordKind(word: string, prevWord: string): TokenKind {
  const key = word.toLowerCase();
  // The FROM object-name slot: Order and Group are real standard Salesforce
  // objects, not the ORDER/GROUP clause keywords — matches the same exception
  // in keyword-case.ts, which decides whether to auto-uppercase the same word.
  if (KEYWORDS.has(key) && prevWord !== 'from') return 'keyword';
  if (FUNCTIONS.has(key)) return 'function';
  // Date literals like LAST_N_DAYS:30 read as values, not keywords.
  if (LITERALS.has(key)) return 'number';
  return 'text';
}

export function tokenizeSoql(text: string): SoqlToken[] {
  if (!text) return [];
  if (text.length > MAX_HIGHLIGHT_CHARS) return [{ start: 0, end: text.length, kind: 'text' }];

  const tokens: SoqlToken[] = [];
  /** Append, merging with the previous token when both are plain text. */
  const push = (start: number, end: number, kind: TokenKind) => {
    const prev = tokens[tokens.length - 1];
    if (prev && prev.kind === 'text' && kind === 'text' && prev.end === start) prev.end = end;
    else tokens.push({ start, end, kind });
  };

  let i = 0;
  let prevWord = '';
  while (i < text.length) {
    const ch = text[i];

    // ── Quoted literal (may be unterminated while typing) ────────────────────
    if (ch === "'") {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\\') j += 2;
        else if (text[j] === "'") {
          j++;
          break;
        } else j++;
      }
      push(i, Math.min(j, text.length), 'string');
      i = Math.min(j, text.length);
      continue;
    }

    // ── Number (leading digit only — identifiers win otherwise) ──────────────
    if (ch >= '0' && ch <= '9') {
      let j = i;
      while (j < text.length && /[0-9.]/.test(text[j])) j++;
      push(i, j, 'number');
      i = j;
      continue;
    }

    // ── Identifier / keyword run ─────────────────────────────────────────────
    if (IDENT_CHAR.test(ch)) {
      let j = i;
      while (j < text.length && IDENT_CHAR.test(text[j])) j++;
      const word = text.slice(i, j);
      push(i, j, wordKind(word, prevWord));
      prevWord = word.toLowerCase();
      i = j;
      continue;
    }

    // ── Symbol operator ──────────────────────────────────────────────────────
    if (OPERATOR_CHAR.test(ch)) {
      let j = i;
      while (j < text.length && OPERATOR_CHAR.test(text[j])) j++;
      push(i, j, 'operator');
      i = j;
      continue;
    }

    // ── Anything else (whitespace, dots, braces…) ────────────────────────────
    push(i, i + 1, 'text');
    i++;
  }

  return tokens;
}

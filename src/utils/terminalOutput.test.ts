import { describe, expect, it } from 'vitest';
import { createLineBuffer } from './terminalOutput';

function collect(chunks: string[]): string[] {
  const lines: string[] = [];
  const buffer = createLineBuffer((line) => lines.push(line));
  chunks.forEach(buffer.push);
  buffer.flush();
  return lines;
}

describe('createLineBuffer', () => {
  it('joins a line split across chunks', () => {
    expect(collect(['Deploy', 'ing…\nDone\n'])).toEqual(['Deploying…', 'Done']);
  });

  it('keeps only the final state of a line redrawn with \r', () => {
    expect(collect(['Progress 10%\rProgress 60%\rProgress 100%\n'])).toEqual(['Progress 100%']);
  });

  it('strips ANSI colour codes', () => {
    expect(collect(['\u001b[32m✔ ok\u001b[39m\n'])).toEqual(['✔ ok']);
  });

  it('treats CRLF as a line ending, not a redraw', () => {
    expect(collect(['first\r\nsecond\r', '\nthird\r\n'])).toEqual(['first', 'second', 'third']);
  });

  it('keeps repeated and blank lines', () => {
    expect(collect(['a\n\na\n'])).toEqual(['a', '', 'a']);
  });

  it('flushes an unterminated last line', () => {
    expect(collect(['no newline'])).toEqual(['no newline']);
  });
});

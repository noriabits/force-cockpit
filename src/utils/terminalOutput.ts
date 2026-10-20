// eslint-disable-next-line no-control-regex -- matching terminal escape sequences is the point
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * What a terminal finally shows for one line: no ANSI codes, and only the
 * text after the last in-place redraw (`\r`). A trailing `\r` is a CRLF line
 * ending, not a redraw, so it is dropped first.
 */
function cleanLine(raw: string): string {
  return raw.replace(ANSI, '').replace(/\r$/, '').split('\r').pop()!.trimEnd();
}

/**
 * Turns the raw chunks of a CLI's output into whole, clean lines.
 *
 * Progress-style CLIs (`sf project deploy`) write many tiny chunks, redraw a
 * line in place with `\r` and colour it with ANSI codes. Logged chunk by chunk
 * that is thousands of junk lines; here a line is emitted only once complete.
 */
export function createLineBuffer(emit: (line: string) => void): {
  push: (chunk: string) => void;
  flush: () => void;
} {
  let pending = '';

  return {
    push(chunk) {
      const parts = (pending + chunk).split('\n');
      pending = parts.pop() ?? '';
      parts.forEach((part) => emit(cleanLine(part)));
    },
    flush() {
      const line = cleanLine(pending);
      if (line) emit(line);
      pending = '';
    },
  };
}

/**
 * Output protocol for script composition.
 *
 * A script called through `runScript()` can hand values back to its caller by
 * printing marker lines. Apex uses `System.debug`, command scripts use stdout;
 * `js` scripts call `setOutput()` instead and never need this parser.
 *
 *   System.debug('::fc-output accountId=' + acc.Id);
 *
 * The value is the rest of the line, trimmed — so it may itself contain `=`.
 * Anything that is not a marker line is left alone, which keeps the convention
 * invisible to scripts that don't use it.
 */

const MARKER_RE = /^\s*::fc-output\s+([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/** Collect every `::fc-output name=value` line from a script's log text. */
export function extractOutputMarkers(text: string | undefined): Record<string, string> {
  if (!text) return {};
  const outputs: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = MARKER_RE.exec(line);
    // Later markers win, so a script can overwrite a value it set earlier.
    if (match) outputs[match[1]] = match[2].trim();
  }
  return outputs;
}

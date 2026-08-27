/**
 * Whether a script's log output starts with "Format JSON" ticked.
 *
 * AI answers and REST responses are JSON-shaped, so rendering them as a table
 * out of the box is what the user wants; apex/command/js honour the script's own
 * `format-json:` YAML default.
 *
 * This lives in its own module because two places decide it — the log viewer
 * when it builds the checkbox, and the execute handler when it resets the
 * checkbox before each run. They disagreed before: the reset unconditionally
 * wrote `script.formatJson ?? false`, so the AI default-on survived exactly
 * until the first execution and then silently vanished.
 */
export function defaultFormatJson(script: { type?: string; formatJson?: boolean }): boolean {
  if (script.type === 'ai' || script.type === 'rest') return true;
  return script.formatJson ?? false;
}

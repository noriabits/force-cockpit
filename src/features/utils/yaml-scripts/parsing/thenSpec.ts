import type { ScriptThenStep } from '../types';
import { validateWhenExpression } from '../execution/thenCondition';

/**
 * Everything that knows the shape of a `then:` block, kept pure and free of the
 * invalid-script-card machinery so it can be tested on its own — the same split
 * `restSpec.ts` and `workspaceFile.ts` already use. `ScriptParser` turns an
 * `{ error }` into the card the UI renders.
 */

/**
 * Normalise the `then:` field — the scripts to run after this one's body.
 * Returns a message instead of throwing, so a malformed block surfaces as an
 * invalid-script card rather than dropping the file.
 *
 * Guard order is load-bearing and pinned by tests: a block with two problems
 * must keep reporting the one it always did.
 */
export function parseThenSteps(raw: unknown): { steps: ScriptThenStep[] } | { error: string } {
  if (raw == null) return { steps: [] };
  if (!Array.isArray(raw)) {
    return { error: "'then' must be a list of steps, each with a 'script' id" };
  }

  const steps: ScriptThenStep[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { error: "Each 'then' step must be an object with a 'script' id" };
    }
    const row = entry as Record<string, unknown>;
    const id = typeof row.script === 'string' ? row.script.trim() : '';
    if (!id) {
      return { error: "Each 'then' step needs a non-empty 'script' id" };
    }

    const step: ScriptThenStep = { script: id };
    if (row.when != null) {
      if (typeof row.when !== 'string') {
        return { error: `'when' on 'then' step "${id}" must be a string condition` };
      }
      const whenError = validateWhenExpression(row.when);
      if (whenError) return { error: whenError };
      if (row.when.trim()) step.when = row.when.trim();
    }
    if (row.with != null) {
      if (typeof row.with !== 'object' || Array.isArray(row.with)) {
        return {
          error: `'with' on 'then' step "${id}" must map input names to values`,
        };
      }
      const values: Record<string, string> = {};
      for (const [key, value] of Object.entries(row.with as Record<string, unknown>)) {
        // Inputs are always strings; YAML would otherwise hand us `true`/`12`
        // for an unquoted checkbox or number value.
        values[key] = value == null ? '' : String(value);
      }
      step.with = values;
    }
    steps.push(step);
  }
  return { steps };
}

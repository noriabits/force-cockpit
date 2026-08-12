import type { ExecuteScriptResult, RunScriptFn, ScriptThenStep } from '../types';
import { clearUnresolvedVars, substituteVars } from '../parsing/PlaceholderResolver';
import { evaluateWhen, resolveWhenExpression } from './thenCondition';

/**
 * The variables a `then:` step's `when:` guard and `with:` values are resolved
 * against — the running script's inputs and its own outputs (outputs win on a
 * name collision, since forwarding what the run just produced is the point).
 */
export function buildThenVars(
  orgUsername: string,
  inputValues: Record<string, string> | undefined,
  outputs: Record<string, string> | undefined,
): Record<string, string> {
  return { orgUsername, ...(inputValues ?? {}), ...(outputs ?? {}) };
}

/**
 * `then.with` values are data handed to the callee, which escapes them for its
 * own type — so they are substituted raw ('command' applies no escaping) here.
 * A name the previous script never published resolves to empty, so the
 * callee's `required:` check reports it instead of the literal `${name}`
 * reaching an org.
 */
function resolveStepInputs(
  step: ScriptThenStep,
  vars: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(step.with ?? {}).map(([key, value]) => [
      key,
      clearUnresolvedVars(substituteVars(value, vars, 'command')),
    ]),
  );
}

/**
 * Both outcomes are announced, with the substituted expression next to the
 * original: a guard that fires the wrong way then shows its own reason,
 * instead of the step silently appearing or vanishing. No trailing newline on
 * the passing line — the step header that follows opens with one.
 */
function announceGuard(
  step: ScriptThenStep,
  vars: Record<string, string>,
  passed: boolean,
): string {
  const detail = `when: ${step.when} → ${resolveWhenExpression(step.when as string, vars)}`;
  return passed
    ? `\n── ✔ ${step.script} (${detail}) ──`
    : `\n── ⏭ ${step.script} skipped (${detail}) ──\n`;
}

/** Result fields a `then:` chain run can override on the parent's own result. */
export type ThenChainOutcome = Partial<
  Pick<ExecuteScriptResult, 'success' | 'message' | 'cancelled'>
>;

/**
 * Runs a script's `then:` steps in order, stopping at the first failure or
 * cancellation. `runStep`/`emit` are the caller's `makeRunScriptFactory`-bound
 * handle so cycle/depth guards and child-log folding stay identical to a `js`
 * script calling `runScript()` itself.
 *
 * @returns `{}` when every step ran (or was guarded off) successfully,
 *          otherwise the `success`/`message`/`cancelled` overrides to apply.
 */
export async function runThenChain(
  steps: ScriptThenStep[],
  vars: Record<string, string>,
  runStep: RunScriptFn,
  emit: (text: string) => void,
): Promise<ThenChainOutcome> {
  for (const step of steps) {
    try {
      const passed = evaluateWhen(step.when, vars);
      if (step.when) emit(announceGuard(step, vars, passed));
      if (!passed) continue;

      await runStep(step.script, resolveStepInputs(step, vars));
    } catch (err) {
      const message = (err as Error).message;
      if (message === 'Operation cancelled') {
        return { cancelled: true, success: false, message: '' };
      }
      emit(`\n--- error ---\n${message}\n`);
      return { success: false, message };
    }
  }
  return {};
}

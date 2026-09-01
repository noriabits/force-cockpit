import type { OrgType } from '../../utils/orgType';
import type { SandboxContext } from '../sandbox/buildSandboxContext';

/**
 * Verbs that change something. Mirrors `DESTRUCTIVE_METHODS` in the REST tab's
 * own controller, which is what decides whether Send prompts.
 */
const DESTRUCTIVE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Org types a mutation must be confirmed against. */
const SENSITIVE: readonly OrgType[] = ['production', 'protected-sandbox'];

export interface SensitiveGateDeps {
  /** Classify the connected org — inject `resolveOrgType` bound to the config. */
  resolveOrgType: () => Promise<OrgType>;
  /**
   * Raise the native modal. Resolves true to proceed. Injected so this module
   * stays vscode-free and unit-testable.
   */
  confirm: (message: string) => Promise<boolean>;
}

/**
 * Wraps the mutating sandbox globals so a plugin cannot write to a production or
 * protected-sandbox org without the user confirming.
 *
 * **Why this is enforced rather than opt-in.** `win.__confirmIfSensitive` is
 * called *voluntarily* by each feature — the REST tab per verb, yaml-scripts on
 * Execute — and nothing checks that a caller remembered. A plugin is authored by
 * a user, so "the author remembered" is not a safe assumption: without this, a
 * handler that simply never asked would mutate production silently, weakening a
 * guarantee the production banner implies. `PluginHost` runs in the extension
 * host, so unlike a webview it can raise the modal itself — no `confirmAction`
 * round-trip — and it can gate at the point the mutation is actually attempted
 * rather than trusting the author to declare intent up front.
 *
 * **Guard rail, not a security boundary.** The raw jsforce `connection`, `fs`,
 * and a shell reached some other way all bypass this, and nothing can close that
 * while the sandbox hands out full filesystem and shell access by design (see
 * `buildSandboxContext`). It is aimed at the case that actually happens: an
 * author who wrote an ordinary handler and never thought about production.
 * Wrapping `connection` in a Proxy to catch `sobject().update/delete` was
 * considered and rejected as brittle for the coverage it adds — `connection` is
 * documented as the unguarded escape hatch.
 *
 * Returns a fresh wrapper per invoke. The "already confirmed" latch lives in
 * that closure, so a handler looping a hundred updates prompts ONCE and the next
 * invoke prompts again.
 */
export function createSensitiveGate(deps: SensitiveGateDeps) {
  return function gate(context: SandboxContext, pluginName: string): SandboxContext {
    let allowed: Promise<void> | null = null;

    /**
     * Single-flight: concurrent mutations in one handler await the same modal
     * rather than stacking several. Mirrors ConnectionManager's `_sessionRefresh`.
     */
    const ensureAllowed = (what: string): Promise<void> => {
      allowed ??= (async () => {
        const orgType = await deps.resolveOrgType();
        if (!SENSITIVE.includes(orgType)) return;
        const where = orgType === 'production' ? 'a production org' : 'a protected sandbox';
        const ok = await deps.confirm(
          `"${pluginName}" wants to ${what} against ${where}. Changes will affect live data.`,
        );
        // The shared sentinel every cancellable path throws, so a declined
        // prompt is indistinguishable from a ✕ Cancel all the way up.
        if (!ok) throw new Error('Operation cancelled');
      })();
      return allowed;
    };

    const executeApex = context.executeApex as (...args: unknown[]) => Promise<unknown>;
    const restCall = context.restCall as (method: string, ...rest: unknown[]) => Promise<unknown>;
    const run = context.run as (cmd: string) => Promise<unknown>;

    return {
      ...context,
      executeApex: async (...args: unknown[]) => {
        await ensureAllowed('run Apex');
        return executeApex(...args);
      },
      restCall: async (method: string, ...rest: unknown[]) => {
        if (DESTRUCTIVE_METHODS.has((method || '').toUpperCase())) {
          await ensureAllowed(`send a ${String(method).toUpperCase()} request`);
        }
        return restCall(method, ...rest);
      },
      run: async (cmd: string) => {
        await ensureAllowed('run a shell command');
        return run(cmd);
      },
    };
  };
}

export type SensitiveGate = ReturnType<typeof createSensitiveGate>;

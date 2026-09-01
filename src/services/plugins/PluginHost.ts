import * as fs from 'fs';
import * as path from 'path';
import { createContext, Script } from 'vm';
import { buildSandboxContext, type SandboxDeps } from '../sandbox/buildSandboxContext';
import { HANDLERS_FILE, type PluginRegistry } from './PluginRegistry';
import { createPluginRequire } from './pluginRequire';
import type { SensitiveGate } from './sensitiveGate';

/** Handler names are indexed off `exports`, never interpolated — but a bad name should say so. */
const HANDLER_NAME_RE = /^[A-Za-z0-9_]+$/;

export interface PluginHostDeps extends SandboxDeps {
  registry: PluginRegistry;
  gate: SensitiveGate;
}

export interface InvokeOptions {
  signal?: AbortSignal;
  onChunk?: (chunk: string) => void;
}

/**
 * Runs a plugin's host-side `handlers.js` in the shared vm sandbox.
 *
 * `handlers.js` assigns onto a provided `exports` object (CommonJS-ish rather
 * than ESM, because `vm` has no module loader and plugins are deliberately
 * unbundled):
 *
 *   exports.search = async ({ status }) => { ... };
 *
 * **The file is re-read and re-parsed on every invoke.** That is deliberate, and
 * buys three things for a cost measured in microseconds on a few KB: `connection`
 * and `org` can never go stale across an org switch; cancellation semantics stay
 * identical to `JsExecutor`; and editing `handlers.js` takes effect on the next
 * click with no reload, which is most of what makes authoring a plugin bearable.
 */
export class PluginHost {
  constructor(private readonly deps: PluginHostDeps) {}

  async invoke(
    pluginId: string,
    handler: string,
    args: unknown,
    options: InvokeOptions = {},
  ): Promise<unknown> {
    const { signal, onChunk } = options;

    // Traversal-safe: the id is matched against the discovered set and the
    // directory comes from that match, so a webview-supplied `../../etc` can
    // never reach a path join.
    const plugin = this.deps.registry.resolve(pluginId);
    if (!plugin) throw new Error(`Unknown plugin "${pluginId}".`);
    if (!HANDLER_NAME_RE.test(handler)) {
      throw new Error(`Invalid handler name "${handler}".`);
    }

    const handlersPath = path.join(plugin.dir, HANDLERS_FILE);
    let code: string;
    try {
      code = fs.readFileSync(handlersPath, 'utf8');
    } catch {
      throw new Error(`Plugin "${plugin.name}" has no ${HANDLERS_FILE}.`);
    }

    const log = (...parts: unknown[]) => onChunk?.(parts.map(String).join(' ') + '\n');
    const error = (...parts: unknown[]) =>
      onChunk?.('[ERROR] ' + parts.map(String).join(' ') + '\n');

    const base = buildSandboxContext(this.deps, { signal, log, error });
    const gated = this.deps.gate(base, plugin.name);
    const exports: Record<string, unknown> = {};
    // `require` needs the contextified sandbox to run a sub-file in, but it has
    // to be IN the object `createContext` is called on — hence the late binding.
    let vmContext: ReturnType<typeof createContext>;
    const contextObj = {
      ...gated,
      exports,
      module: { exports },
      args,
      pluginId: plugin.id,
      pluginDir: plugin.dir,
      __handlerName: handler,
      // Lets a plugin split its host logic across files instead of growing one
      // unbounded handlers.js. Confined to the plugin folder; cached per invoke,
      // so an edit to any file is still live on the next click.
      require: createPluginRequire({
        pluginDir: plugin.dir,
        getContext: () => vmContext,
        globals: gated,
      }),
    };

    vmContext = createContext(contextObj);
    // The handler is looked up by key off `exports`, so the name never reaches
    // the source text — a name like `x; process.exit()` cannot be injected even
    // if it slipped past HANDLER_NAME_RE.
    //
    // OWN properties only. `exports` is a plain object, so `exports.toString`,
    // `.constructor` and `.valueOf` are all inherited functions — a bare lookup
    // would pass the typeof guard and CALL a method the plugin never wrote,
    // returning `[object Object]` instead of saying the handler does not exist.
    // HANDLER_NAME_RE cannot catch these: they are ordinary identifiers.
    const wrapped = [
      '(async () => {',
      code,
      ';',
      'const __own = (o, k) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);',
      'const __fn = __own(exports, __handlerName) ?? __own(module.exports, __handlerName);',
      `if (typeof __fn !== 'function') throw new Error('Plugin handler "' + __handlerName + '" is not defined.');`,
      'return await __fn(args);',
      '})()',
    ].join('\n');

    const execution = new Script(wrapped).runInContext(vmContext, {
      breakOnSigint: true,
    }) as Promise<unknown>;

    if (!signal) return execution;
    // Races rather than kills: the vm script cannot be force-stopped, so the
    // cancel stops the *wait*, exactly as JsExecutor does. Which means the
    // script is still running after the race is lost — and if it then rejects,
    // nothing is left listening. Claim it here: an unhandled rejection in the
    // extension host is a process-level warning (a crash under a strict
    // runtime) for a failure the user already cancelled.
    void execution.catch(() => {});
    const abortPromise = new Promise<never>((_, reject) =>
      signal.addEventListener('abort', () => reject(new Error('Operation cancelled')), {
        once: true,
      }),
    );
    return Promise.race([execution, abortPromise]);
  }
}

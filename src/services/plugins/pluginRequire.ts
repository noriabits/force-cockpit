import * as fs from 'fs';
import * as path from 'path';
import { runInContext, type Context } from 'vm';
import type { SandboxContext } from '../sandbox/buildSandboxContext';

/**
 * Module specifiers a plugin may `require` by name, mapped onto the sandbox
 * globals it already has. Nothing here is a real module load — it hands back the
 * same object that is already in scope, so `require('fs')` and the bare `fs`
 * global are the same thing.
 *
 * The list is deliberately short: these are the only globals whose npm name a
 * plugin author is likely to reach for out of habit.
 */
const BUILTINS: Readonly<Record<string, string>> = {
  fs: 'fs',
  os: 'os',
  path: 'path',
  'js-yaml': 'yaml',
};

export interface PluginRequireOptions {
  /** Absolute plugin folder — nothing outside it can be required. */
  pluginDir: string;
  /**
   * The contextified sandbox. Late-bound because `require` has to BE in the
   * context object before `createContext` can be called on it.
   */
  getContext: () => Context;
  /** The sandbox globals, for the `BUILTINS` lookup. */
  globals: SandboxContext;
}

/**
 * `require` for a plugin's own files.
 *
 * A plugin's `handlers.js` runs in a bare `vm` context, which has no module
 * loader — so without this, every handler and every helper has to live in one
 * file however large it grows. This is CommonJS `require`, confined to the
 * plugin folder: relative paths only, plus the handful of built-ins above.
 *
 * Named `require` rather than something bespoke because it genuinely is
 * `require` — same `exports` object, same caching, same relative resolution —
 * and every JS author already knows it. The one difference from Node (no npm
 * packages) is stated by the error rather than encoded in the name.
 *
 * Files are cached per INVOKE, not for the life of the panel: two files sharing
 * a helper parse it once per click, while editing any of them still takes effect
 * on the next click — the same rule `handlers.js` itself follows.
 */
export function createPluginRequire(options: PluginRequireOptions): (spec: unknown) => unknown {
  const root = path.resolve(options.pluginDir);
  const cache = new Map<string, unknown>();

  function requireFrom(fromDir: string): (spec: unknown) => unknown {
    return (spec: unknown) => {
      const request = String(spec ?? '');

      const builtin = BUILTINS[request];
      if (builtin) return options.globals[builtin];

      if (!request.startsWith('./') && !request.startsWith('../')) {
        throw new Error(
          `require("${request}"): a plugin can only require its own files — use a relative ` +
            `path like "./lib/jobs.js" — or one of: ${Object.keys(BUILTINS).join(', ')}. ` +
            `npm packages are not available.`,
        );
      }

      const resolved = resolveInside(root, fromDir, request);
      if (cache.has(resolved)) return cache.get(resolved);

      let code: string;
      try {
        code = fs.readFileSync(resolved, 'utf8');
      } catch (err) {
        throw new Error(`require("${request}"): could not read the file (${message(err)}).`);
      }

      const mod = { exports: {} as Record<string, unknown> };
      // Seeded BEFORE the file runs, so a cycle (a requires b requires a) gets
      // back a partially-filled exports object instead of recursing forever.
      // Node does exactly this.
      cache.set(resolved, mod.exports);

      // The Node module wrapper. Running it in the SAME context is what lets a
      // helper file use `query`, `log`, `fs` and the rest with no plumbing;
      // taking `exports`/`module`/`require` as PARAMETERS is what stops it
      // clobbering the top-level handler file's own `exports` global.
      const dir = path.dirname(resolved);
      let wrapper: (...args: unknown[]) => void;
      try {
        wrapper = runInContext(
          `(function (exports, module, require, __filename, __dirname) {\n${code}\n})`,
          options.getContext(),
          { filename: resolved },
        ) as (...args: unknown[]) => void;
      } catch (err) {
        cache.delete(resolved);
        throw new Error(`require("${request}"): ${message(err)}`);
      }

      try {
        wrapper(mod.exports, mod, requireFrom(dir), resolved, dir);
      } catch (err) {
        // A file that threw is not a module anyone should get half of.
        cache.delete(resolved);
        throw err;
      }

      // A file may REPLACE its exports wholesale (`module.exports = fn`), in
      // which case the object seeded above is no longer the right one.
      cache.set(resolved, mod.exports);
      return mod.exports;
    };
  }

  return requireFrom(root);
}

/**
 * Resolve a relative specifier, refusing anything outside the plugin folder.
 *
 * Same `path.resolve` + `startsWith(root + sep)` shape as
 * `parsing/workspaceFile.ts` — the trailing separator is what stops a sibling
 * folder like `/plugins/orders-evil` matching `/plugins/orders`.
 */
function resolveInside(root: string, fromDir: string, request: string): string {
  const base = path.resolve(fromDir, request);
  if (base !== root && !base.startsWith(root + path.sep)) {
    throw new Error(
      `require("${request}"): a plugin can only require files inside its own folder.`,
    );
  }

  // Node's resolution order, minus the parts that need a package.json.
  for (const candidate of [base, `${base}.js`, path.join(base, 'index.js')]) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Not there — try the next shape.
    }
  }

  throw new Error(`require("${request}"): no such file in the plugin folder.`);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

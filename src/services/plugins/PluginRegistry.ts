import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

/** Where a plugin was discovered. `private` shadows `user` on an id collision. */
export type PluginSource = 'user' | 'private';

/** A plugin discovered on disk — valid or visibly broken. */
export interface PluginInfo {
  /** Stable id — the plugin's folder name. */
  id: string;
  /** Display name (manifest `name`, falling back to the id). */
  name: string;
  /** One-line summary (manifest `description`). */
  description: string;
  /** Optional emoji prefixed to the sub-tab label. */
  icon: string;
  /** Absolute path of the plugin folder. */
  dir: string;
  source: PluginSource;
  /**
   * A folder with NO `plugin.yaml` is not a plugin and never appears here. One
   * WITH a manifest that fails validation does, flagged — a broken plugin must
   * be visible and self-diagnosing rather than silently missing. Mirrors
   * `ScriptParser.makeInvalidScript`.
   */
  invalid?: boolean;
  error?: string;
}

/** The manifest file that marks a folder as a plugin. Not exported: nothing
 * outside this module needs to know the filename. */
const MANIFEST_FILE = 'plugin.yaml';
/** Required — the fragment rendered into the plugin's sub-tab panel. */
export const VIEW_HTML_FILE = 'view.html';
/** Optional webview assets. */
export const VIEW_JS_FILE = 'view.js';
export const VIEW_CSS_FILE = 'view.css';
/** Host-side handlers, read fresh on every invoke (see PluginHost). */
export const HANDLERS_FILE = 'handlers.js';

interface ScanDir {
  dir: string;
  source: PluginSource;
}

/**
 * Discovers user-authored plugins from the workspace.
 *
 * A plugin is a sub-folder of `force-cockpit/plugins/` (or `private/plugins/`)
 * containing a `plugin.yaml`. The id is the folder name, one level deep — the
 * same shape as `SkillsRepository`, and for the same reason: the id is the only
 * thing the webview ever sends back, so it must be resolvable against a
 * discovered set rather than joined into a path.
 *
 * vscode-free (pure `fs`/`path`/`js-yaml`) so it is unit-testable without a
 * window. Built once in `extension.ts` and injected into `MainPanel`.
 */
export class PluginRegistry {
  private readonly scanDirs: ScanDir[];

  /**
   * @param userPluginsDir absolute path of `{cockpitPath}/plugins`.
   * @param privatePluginsDir absolute path of `{cockpitPath}/private/plugins`.
   *        Scanned first, so a private plugin shadows a shared one of the same
   *        name — the same first-match-wins direction `SkillsRepository` uses.
   */
  constructor(userPluginsDir: string, privatePluginsDir: string) {
    this.scanDirs = [
      { dir: privatePluginsDir, source: 'private' },
      { dir: userPluginsDir, source: 'user' },
    ];
  }

  /** Every plugin across both dirs, deduped by id, sorted by display name. */
  list(): PluginInfo[] {
    const byId = new Map<string, PluginInfo>();
    for (const { dir, source } of this.scanDirs) {
      for (const info of scanDir(dir, source)) {
        if (!byId.has(info.id)) byId.set(info.id, info);
      }
    }
    return Array.from(byId.values()).sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
    );
  }

  /**
   * Resolve a plugin id to its folder, or `null` when the id is not one this
   * registry discovered. Traversal-safe by construction: the id is matched
   * against the discovered set and the directory comes from the match, so a
   * webview-supplied `../../etc` can never be joined into a path.
   */
  resolve(id: string): PluginInfo | null {
    return this.list().find((p) => p.id === id && !p.invalid) ?? null;
  }
}

// ── Private helpers ──────────────────────────────────────────────────────────

function scanDir(root: string, source: PluginSource): PluginInfo[] {
  if (!root || !path.isAbsolute(root)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return []; // missing dir → skip silently, exactly like the YAML loader
  }
  const plugins: PluginInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8');
    } catch {
      continue; // no plugin.yaml → not a plugin folder
    }
    plugins.push(buildInfo(entry.name, dir, source, raw));
  }
  return plugins;
}

function buildInfo(id: string, dir: string, source: PluginSource, raw: string): PluginInfo {
  const base: PluginInfo = { id, name: id, description: '', icon: '', dir, source };

  let doc: unknown;
  try {
    doc = yaml.load(raw);
  } catch (err) {
    return { ...base, invalid: true, error: `${MANIFEST_FILE} is not valid YAML: ${msg(err)}` };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ...base, invalid: true, error: `${MANIFEST_FILE} must be a YAML mapping.` };
  }

  const manifest = doc as Record<string, unknown>;
  const name = typeof manifest.name === 'string' ? manifest.name.trim() : '';
  if (!name) {
    return { ...base, invalid: true, error: `${MANIFEST_FILE} is missing a "name".` };
  }

  const info: PluginInfo = {
    ...base,
    name,
    description: typeof manifest.description === 'string' ? manifest.description.trim() : '',
    icon: typeof manifest.icon === 'string' ? manifest.icon.trim() : '',
  };

  if (!fs.existsSync(path.join(dir, VIEW_HTML_FILE))) {
    return { ...info, invalid: true, error: `Missing ${VIEW_HTML_FILE}.` };
  }
  return info;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

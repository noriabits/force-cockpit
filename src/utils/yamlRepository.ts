import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

/**
 * Shared YAML-repository helpers for feature persistence layers (yaml-scripts,
 * monitoring). Both store items as `{basePath}/{folder}/{basename}.yaml` keyed
 * by an id of the form `{folder}/{basename}` (folder may itself be nested).
 */

/**
 * Serialize a value to YAML with line wrapping disabled. js-yaml's default
 * lineWidth (80) folds long lines into a `>-` scalar that encodes each real
 * line break as a blank line — disastrous for code/SOQL. `lineWidth: -1`
 * keeps a clean `|-` literal block with exact line breaks.
 */
export function dumpYaml(data: unknown): string {
  return yaml.dump(data, { lineWidth: -1 });
}

/** Split an item id (`"parent/sub/name"`) into its folder + basename parts. */
export function splitItemId(id: string): { folder: string; basename: string } {
  const parts = id.split('/');
  return {
    folder: parts.slice(0, -1).join('/'),
    basename: parts[parts.length - 1],
  };
}

/** Resolve an existing `.yaml` (preferred) or `.yml` file path, or null if neither exists. */
export function resolveYamlPath(basePath: string, folder: string, basename: string): string | null {
  const yamlPath = path.join(basePath, folder, `${basename}.yaml`);
  if (fs.existsSync(yamlPath)) return yamlPath;
  const ymlPath = path.join(basePath, folder, `${basename}.yml`);
  if (fs.existsSync(ymlPath)) return ymlPath;
  return null;
}

/**
 * Throw when an item with the same id already exists in the *other* base path
 * (shared ↔ private). `noun` is the item kind ("script" / "config") and
 * `otherLabel` is the location wording shown to the user ("shared" / "private").
 */
export function checkDuplicateId(
  id: string,
  otherBasePath: string,
  opts: { noun: string; otherLabel: 'shared' | 'private' },
): void {
  if (!otherBasePath || !fs.existsSync(otherBasePath)) return;
  const { folder, basename } = splitItemId(id);
  if (resolveYamlPath(otherBasePath, folder, basename)) {
    throw new Error(
      `A ${opts.noun} with the same category and name already exists in the ${opts.otherLabel} folder.`,
    );
  }
}

/** Delete the `.yaml`/`.yml` file backing an item id. Throws if neither exists. */
export function deleteYamlItem(basePath: string, id: string, noun: string): void {
  const { folder, basename } = splitItemId(id);
  const target = resolveYamlPath(basePath, folder, basename);
  if (!target) {
    throw new Error(`Cannot delete: ${noun} not found.`);
  }
  fs.unlinkSync(target);
}

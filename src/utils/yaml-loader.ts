import * as fs from 'fs';
import * as path from 'path';

export type YamlSource = 'builtin' | 'user' | 'private';

export interface YamlLoaderPaths {
  builtInPath: string;
  userPath: string;
  privatePath: string;
}

/**
 * Callback that converts a single YAML file into a typed item.
 * Return null to skip the file (e.g. parse/validation failure).
 */
export type YamlParseCallback<T> = (
  filePath: string,
  id: string,
  folder: string,
  source: YamlSource,
) => T | null;

/**
 * Three-way merge loader: builtin < user < private.
 *
 * Walks each base path for `{category}/{file}.yaml` and
 * `{category}/{sub-category}/{file}.yaml` entries, calls `parse` for each
 * file, merges results by `id` (later sources win), and returns sorted by name.
 * Uses async file operations to avoid blocking the event loop.
 */
export async function loadYamlItems<T extends { id: string; name: string }>(
  paths: YamlLoaderPaths,
  parse: YamlParseCallback<T>,
): Promise<T[]> {
  const [builtIn, user, priv] = await Promise.all([
    loadFromPath(paths.builtInPath, 'builtin', parse),
    loadFromPath(paths.userPath, 'user', parse),
    loadFromPath(paths.privatePath, 'private', parse),
  ]);

  const map = new Map<string, T>();
  for (const item of builtIn) map.set(item.id, item);
  for (const item of user) map.set(item.id, item);
  for (const item of priv) map.set(item.id, item);

  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

async function loadFromPath<T extends { id: string; name: string }>(
  basePath: string,
  source: YamlSource,
  parse: YamlParseCallback<T>,
): Promise<T[]> {
  if (!basePath) return [];

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(basePath, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: T[] = [];
  const folderTasks: Promise<void>[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const parentFolder = entry.name;
    const folderPath = path.join(basePath, parentFolder);

    // Process this folder and its subfolders concurrently
    folderTasks.push(
      (async () => {
        let folderEntries: fs.Dirent[];
        try {
          folderEntries = await fs.promises.readdir(folderPath, { withFileTypes: true });
        } catch {
          return;
        }

        // Load YAML files from parent folder
        await loadYamlFilesFromDir(folderPath, parentFolder, source, results, parse);

        // One level of sub-folder nesting supported
        const subfolderTasks: Promise<void>[] = [];
        for (const subEntry of folderEntries) {
          if (!subEntry.isDirectory()) continue;
          const subFolder = `${parentFolder}/${subEntry.name}`;
          const subFolderPath = path.join(folderPath, subEntry.name);
          subfolderTasks.push(
            loadYamlFilesFromDir(subFolderPath, subFolder, source, results, parse),
          );
        }
        await Promise.all(subfolderTasks);
      })(),
    );
  }

  await Promise.all(folderTasks);
  return results;
}

async function loadYamlFilesFromDir<T extends { id: string; name: string }>(
  dirPath: string,
  folder: string,
  source: YamlSource,
  results: T[],
  parse: YamlParseCallback<T>,
): Promise<void> {
  let files: string[];
  try {
    files = await fs.promises.readdir(dirPath);
    files = files.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
  } catch {
    return;
  }

  for (const file of files) {
    const filePath = path.join(dirPath, file);
    const id = `${folder}/${path.basename(file, path.extname(file))}`;
    const result = parse(filePath, id, folder, source);
    if (result !== null) results.push(result);
  }
}

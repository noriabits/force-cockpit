import * as fs from 'fs';
import * as path from 'path';

/**
 * Reads a workspace-relative file, enforcing that it stays inside the workspace
 * root (no path traversal). Shared by the script-content resolver and the
 * `ai` gather-step resolver so both apply identical safety checks.
 */
export function resolveWorkspaceFile(
  workspaceRoot: string,
  relPath: string,
): { content: string } | { error: string } {
  if (!workspaceRoot) {
    return { error: 'Cannot resolve file path: no workspace folder is open.' };
  }
  const absPath = path.resolve(workspaceRoot, relPath);
  const rootResolved = path.resolve(workspaceRoot);
  if (!absPath.startsWith(rootResolved + path.sep) && absPath !== rootResolved) {
    return { error: 'Script file must be inside the workspace folder.' };
  }
  if (!fs.existsSync(absPath)) {
    return { error: `Script file not found: ${relPath}` };
  }
  try {
    return { content: fs.readFileSync(absPath, 'utf8') };
  } catch (err) {
    return { error: `Failed to read script file: ${(err as Error).message}` };
  }
}

// Maps our neutral WorkspaceSearch type (types.ts) to the VS Code workspace
// file-search API so AiExecutor stays vscode-free and unit-testable.
// Constructed in the feature `index.ts`.
//
// The stable VS Code API (`workspace.findFiles`) honors `files.exclude` /
// `search.exclude` but NOT `.gitignore`, so we additionally filter results
// through a gitignore matcher built from the workspace-root `.gitignore`
// (see gitignoreFilter.ts) — the user asked for "any file not in .gitignore".
import * as vscode from 'vscode';
import { buildGitignoreMatcher } from './gitignoreFilter';
import type { WorkspaceSearch } from './types';

/** Max files returned from a search. */
const MAX_RESULTS = 100;
/** Max files enumerated before filtering (guards huge workspaces). */
const MAX_CANDIDATES = 5000;

/** Strip a Salesforce metadata source root from a path for compact display. */
function displayPath(uri: vscode.Uri): string {
  const rel = vscode.workspace.asRelativePath(uri, false);
  return rel.replace(/\\/g, '/');
}

/** The file name (last path segment) of a workspace-relative path. */
function baseName(relPath: string): string {
  return relPath.split('/').pop() ?? relPath;
}

export class VsCodeWorkspaceSearch implements WorkspaceSearch {
  async searchFiles(
    pattern: string,
  ): Promise<{ paths: string[]; truncated: boolean } | { error: string }> {
    const p = pattern.trim();
    if (!p) return { error: 'no search pattern provided' };

    let re: RegExp;
    try {
      re = new RegExp(p, 'i');
    } catch (err) {
      return { error: `invalid regular expression: ${(err as Error).message}` };
    }

    const isIgnored = await this.getIgnoreMatcher();
    const uris = await vscode.workspace.findFiles('**/*', undefined, MAX_CANDIDATES);
    const candidatesCapped = uris.length >= MAX_CANDIDATES;
    const matched = uris
      .map(displayPath)
      .filter((rel) => !isIgnored(rel) && re.test(baseName(rel)));
    const truncated = candidatesCapped || matched.length > MAX_RESULTS;
    return { paths: matched.slice(0, MAX_RESULTS), truncated };
  }

  async readFile(relPath: string): Promise<{ path: string; content: string } | { error: string }> {
    const rel = relPath.trim().replace(/\\/g, '/');
    if (!rel) return { error: 'no file path provided' };

    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) return { error: 'no workspace folder is open' };

    const target = vscode.Uri.joinPath(root, rel);
    // Traversal guard: the resolved path must stay inside the workspace root.
    const rootPath = root.fsPath.replace(/\\/g, '/').replace(/\/$/, '');
    const targetPath = target.fsPath.replace(/\\/g, '/');
    if (targetPath !== rootPath && !targetPath.startsWith(rootPath + '/')) {
      return { error: `"${relPath}" is outside the workspace` };
    }

    const isIgnored = await this.getIgnoreMatcher();
    if (isIgnored(displayPath(target))) {
      return { error: `"${relPath}" is excluded by .gitignore` };
    }

    try {
      const bytes = await vscode.workspace.fs.readFile(target);
      return { path: displayPath(target), content: Buffer.from(bytes).toString('utf8') };
    } catch (err) {
      return { error: `could not read "${relPath}": ${(err as Error).message}` };
    }
  }

  /** Build a git-ignore predicate from the workspace-root `.gitignore` (best-effort). */
  private async getIgnoreMatcher(): Promise<(relPath: string) => boolean> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) return buildGitignoreMatcher();
    const contents: string[] = [];
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, '.gitignore'));
      contents.push(Buffer.from(bytes).toString('utf8'));
    } catch {
      // No .gitignore — only the implicit .git/ exclusion applies.
    }
    return buildGitignoreMatcher(contents);
  }
}

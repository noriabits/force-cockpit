// Pure, vscode-free helper: turns `.gitignore` file contents into a predicate
// that reports whether a workspace-relative path is git-ignored. Used by
// VsCodeWorkspaceSearch so the AI workspace-file tools never surface anything
// the user keeps out of source control (e.g. force-cockpit/private/, auth dirs).
import ignore from 'ignore';

/**
 * Build a matcher from zero or more `.gitignore` file contents.
 * Returns a predicate that is `true` when the given workspace-relative POSIX
 * path is ignored. The `.git/` directory is always treated as ignored.
 */
export function buildGitignoreMatcher(
  gitignoreContents: string[] = [],
): (relPath: string) => boolean {
  const ig = ignore();
  ig.add('.git/');
  for (const content of gitignoreContents) {
    if (content) ig.add(content);
  }
  return (relPath: string): boolean => {
    const rel = (relPath ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel) return false;
    return ig.ignores(rel);
  };
}

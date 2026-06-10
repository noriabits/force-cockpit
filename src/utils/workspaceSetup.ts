import * as fs from 'fs';
import * as path from 'path';

/**
 * Auto-creates the user folders Force Cockpit relies on (scripts/, monitoring/,
 * private/scripts/, private/monitoring/) and drops a `.gitignore` (`*`) inside
 * private/ so its contents are never committed. No-ops on a relative path.
 * `.gitignore` writing is best-effort — failures are swallowed.
 */
export function ensureUserFolders(userBasePath: string): void {
  if (!path.isAbsolute(userBasePath)) return;
  fs.mkdirSync(path.join(userBasePath, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(userBasePath, 'monitoring'), { recursive: true });
  fs.mkdirSync(path.join(userBasePath, 'private', 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(userBasePath, 'private', 'monitoring'), { recursive: true });
  const privateGitignore = path.join(userBasePath, 'private', '.gitignore');
  if (!fs.existsSync(privateGitignore)) {
    try {
      fs.writeFileSync(privateGitignore, '*\n', 'utf8');
    } catch {
      // Silent — gitignore management is best-effort
    }
  }
}

// Maps our neutral WorkspaceSearch type (types.ts) to the VS Code workspace
// file-search API so AiExecutor stays vscode-free and unit-testable.
// Constructed in the feature `index.ts`.
import * as vscode from 'vscode';
import type { WorkspaceSearch } from './types';

/** Strip a Salesforce metadata source root from a path for compact display. */
function displayPath(uri: vscode.Uri): string {
  const rel = vscode.workspace.asRelativePath(uri, false);
  return rel.replace(/\\/g, '/');
}

export class VsCodeWorkspaceSearch implements WorkspaceSearch {
  async findApexClass(
    className: string,
  ): Promise<{ path: string; content: string } | { error: string }> {
    const name = className.trim();
    if (!name) return { error: 'no class name provided' };
    // Reject anything that is not a bare identifier so the glob cannot be used
    // to traverse outside the workspace or match unintended files.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      return { error: `"${name}" is not a valid Apex class or trigger name` };
    }

    // Apex classes live in *.cls; triggers in *.trigger. Try class first.
    let matches = await vscode.workspace.findFiles(`**/${name}.cls`, null, 2);
    if (matches.length === 0) {
      matches = await vscode.workspace.findFiles(`**/${name}.trigger`, null, 2);
    }

    if (matches.length === 0) {
      return { error: `no Apex class or trigger named "${name}" found in the workspace` };
    }
    if (matches.length > 1) {
      const paths = matches.map(displayPath).join(', ');
      return { error: `multiple files match "${name}": ${paths}` };
    }

    try {
      const bytes = await vscode.workspace.fs.readFile(matches[0]);
      return { path: displayPath(matches[0]), content: Buffer.from(bytes).toString('utf8') };
    } catch (err) {
      return { error: `could not read "${name}": ${(err as Error).message}` };
    }
  }
}

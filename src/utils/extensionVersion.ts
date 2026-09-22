import type * as vscode from 'vscode';

/**
 * The installed extension's version, as declared in package.json.
 *
 * Shown in two places — the sidebar view title and the Overview tab's footer —
 * so the read lives here rather than in both. `extension` is absent from the
 * stub contexts the unit tests build, and a missing version must not blank the
 * whole webview, hence the empty-string fallback.
 */
export function extensionVersion(context: vscode.ExtensionContext): string {
  const version = context.extension?.packageJSON?.version;
  return typeof version === 'string' ? version : '';
}

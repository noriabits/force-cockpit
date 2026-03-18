import type { ConnectionManager } from '../salesforce/connection';

export interface RouteDescriptor {
  handler: (
    message: Record<string, unknown>,
    signal?: AbortSignal,
    onChunk?: (chunk: string) => void,
  ) => Promise<unknown>;
  successType: string;
  errorType: string;
}

export interface FeatureModule {
  id: string;
  tab: string; // matches id="tab-{tab}" in main.html
  // Relative paths from context.extensionPath (resolved in MainPanel)
  htmlPath: string; // e.g. path.join('dist', 'features', 'utils', 'clone-user', 'view.html')
  jsPath: string; // e.g. path.join('dist', 'features', 'utils', 'clone-user', 'view.js')
  cssPath: string; // e.g. path.join('dist', 'features', 'utils', 'clone-user', 'view.css')
  // Optional: labels script loaded (with defer) before jsPath.
  // Should set a global (e.g. window.MyFeatureLabels) with all user-facing strings
  // so they are centralised and not scattered across view.js and view.html.
  labelsPath?: string; // e.g. path.join('dist', 'features', 'utils', 'clone-user', 'labels.js')
  routes: Record<string, RouteDescriptor>;
}

export type FeatureModuleFactory = (connectionManager: ConnectionManager) => FeatureModule;

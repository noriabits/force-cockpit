import type { FeatureContext } from './FeatureContext';
import type { HostToWebviewType, WebviewToHostType } from '../shared/protocol';

/**
 * Resolve a handler with this to post nothing back. For routes that are
 * deliberately silent: fire-and-forget persistence, work that reports through a
 * native VS Code dialog, or a run the webview has already abandoned.
 */
export const NO_REPLY = Symbol('no-reply');

/**
 * Throw this instead of a plain Error to put extra fields on the error payload
 * (e.g. the SOQL tab's diagnostics riding alongside the raw Salesforce message).
 */
export class RouteError extends Error {
  constructor(
    message: string,
    public readonly data: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'RouteError';
  }
}

export interface RouteDescriptor {
  handler: (
    message: Record<string, unknown>,
    signal?: AbortSignal,
    onChunk?: (chunk: string) => void,
  ) => Promise<unknown>;
  // Typed against the shared protocol so a typo is a build error rather than a
  // reply the webview silently never receives. Adding a route means adding its
  // names to the unions in src/shared/protocol/messages.ts first.
  successType: HostToWebviewType;
  errorType: HostToWebviewType;
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
  routes: Partial<Record<WebviewToHostType, RouteDescriptor>>;
  // Optional: release any resources the factory acquired (e.g. registered
  // providers/emitters). Called by MainPanel when the panel is disposed so a
  // reopened panel can re-create the feature without leaking registrations.
  dispose?: () => void;
}

/**
 * A feature is built from the shared context, not from a bare ConnectionManager.
 * Use `defineFeature` unless the feature genuinely needs to expose something
 * beyond a FeatureModule (monitoring returns its BackgroundRefresher too).
 */
export type FeatureModuleFactory = (ctx: FeatureContext) => FeatureModule;

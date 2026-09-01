// The typed seam between a webview component and the extension host.
//
// Before this, every view module reached for the `window.__*` globals directly
// (`win.__vscode.postMessage`, `win.__onMessage`) through an `any` cast, so
// neither the message name nor its payload was checked. Components import this
// instead and never touch the globals.
//
// Named `.tsx` despite containing no JSX: `.tsx` is this repo's marker for
// "browser-context TypeScript". The host tsconfig compiles every `src/**/*.ts`
// with no DOM lib (which is why the pure `view/*.ts` helpers must stay
// DOM-free), and excludes `.tsx`. A DOM-coupled module therefore has to carry
// that extension to be compiled by the webview config only.
//
// The globals themselves stay — `media/modules/ipc.js` still owns the single
// `message` listener and the dispatch registry. This is a typed facade over
// them, not a replacement, so bundled and non-bundled features keep interop.
//
// Both directions are here. `on()` arrived with its first real consumer, the
// REST tab's six inbound handlers — it was deliberately absent before that,
// because shipping an unexercised receive helper is how a facade drifts out of
// step with what it wraps.

import type { HostMessage, HostToWebviewType, WebviewToHostType } from '../../../shared/protocol';

interface VsCodeApi {
  postMessage(message: unknown): void;
}

interface CockpitGlobals {
  __vscode: VsCodeApi;
  __onMessage(type: string, handler: (msg: unknown) => void): void;
}

function globals(): CockpitGlobals {
  // ipc.js is FIRST in WebviewAssets.WEBVIEW_MODULES, and every other module
  // comes after it: the remaining WEBVIEW_MODULES entries are plain synchronous
  // <script> tags in that order, and the per-feature bundles are `defer`. So
  // these are always present by the time any of this runs.
  return window as unknown as CockpitGlobals;
}

/**
 * Send a request to the host. The `type` is checked against the shared protocol.
 *
 * Generic rather than taking `WebviewMessage` directly: that envelope carries an
 * `[key: string]: unknown` index signature, and a precisely-typed message
 * interface (`SaveMonitoringConfigMessage`, …) is NOT assignable to one. Taking
 * `M extends { type: WebviewToHostType }` accepts both the precise interfaces
 * and an ad-hoc object literal, while still rejecting a name that is not in the
 * protocol — and excess-property checking still applies to literals.
 */
export function post<M extends { type: WebviewToHostType }>(message: M): void {
  globals().__vscode.postMessage(message);
}

/**
 * Subscribe to a host reply or push. The `type` is checked against the INBOUND
 * union, which is what catches the third bug class the protocol header names: an
 * `__onMessage(name)` whose name is in the *outbound* union — a handler that can
 * never fire, because nothing on the host posts under a webview→host name.
 * `media/modules/action-tracker.js` shipped two of those.
 *
 * `TData` is supplied per call site rather than inferred from a per-type payload
 * map: no such map exists, and adding one is a larger change than this facade.
 *
 * Returns void, not an unsubscribe. `ipc.js`'s registry has no removal API, and
 * inventing a teardown the bus cannot honour is exactly the drift this file
 * exists to prevent.
 */
export function on<TData = unknown>(
  type: HostToWebviewType,
  handler: (msg: HostMessage<TData>) => void,
): void {
  globals().__onMessage(type, handler as (msg: unknown) => void);
}

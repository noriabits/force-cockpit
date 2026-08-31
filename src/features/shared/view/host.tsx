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
// Only the SEND direction is here. A typed `on(type, handler)` wrapper over
// `win.__onMessage` belongs beside its first real consumer — the migrated
// components so far only post, and shipping an unexercised receive helper is
// how a facade drifts out of step with what it wraps.

import type { WebviewToHostType } from '../../../shared/protocol';

interface VsCodeApi {
  postMessage(message: unknown): void;
}

interface CockpitGlobals {
  __vscode: VsCodeApi;
}

function globals(): CockpitGlobals {
  // ipc.js runs before every feature bundle (it is first in
  // WebviewAssets.WEBVIEW_MODULES and feature scripts are `defer`), so these
  // are always present by the time a component mounts.
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

/**
 * Names a REST request tab after the resource it calls — `Account`, `Account (1)`
 * — the way a query tab is named after its FROM object. Pure and DOM-free; the
 * tab strip calls it whenever the active tab's method or endpoint changes.
 *
 * Only the REST-specific half lives here: what an endpoint's base name *is*. The
 * de-duplication and rename rules are shared — see
 * `src/features/shared/view/tab-naming.ts`.
 */

/** Verb assumed when a tab has none yet, so the fallback name is never bare. */
const FALLBACK_METHOD = 'GET';

/**
 * The label a request wants before de-duplication: the last meaningful segment
 * of its endpoint path.
 *
 *   /services/data/v65.0/sobjects/Account      → Account
 *   /services/data/v65.0/sobjects/Account/001x → 001x
 *   /services/apexrest/MyService/v1            → v1
 *
 * A query string, a fragment and trailing slashes are stripped first, and an
 * absolute URL loses its scheme and host — otherwise every tab pointing at the
 * same host would be named after that host.
 *
 * With no usable segment left (a blank endpoint, or `/`), the verb carries the
 * name instead: `POST Request`, `GET Request`. New tabs start empty, so without
 * this they would all read `Request` and only the ` (n)` suffix would tell them
 * apart; the method is the one thing such a tab does hold.
 */
export function endpointBaseName(endpoint: string, method: string): string {
  const verb = (method || '').trim().toUpperCase() || FALLBACK_METHOD;
  let path = (endpoint || '').trim();
  // Drop the query string / fragment: `?fields=Name` names nothing.
  path = path.split(/[?#]/)[0];
  // An absolute URL's host is shared by every endpoint on the org — skip past it.
  const absolute = /^[a-z][a-z0-9+.-]*:\/\/[^/]*(\/.*)?$/i.exec(path);
  if (absolute) path = absolute[1] ?? '';
  const segments = path.split('/').filter((segment) => segment.trim() !== '');
  const last = segments[segments.length - 1];
  return last ?? `${verb} Request`;
}

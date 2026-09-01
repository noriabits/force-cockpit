// Routes incoming webview messages to their handlers:
//   - Built-in host routes (ready, openRecord, openInBrowser, refreshOrg,
//     confirmAction, openExternalUrl, restCall, loadRestCallState,
//     saveRestCallTabs, addRestCallHistory, saveRestCallSavedRequests, describeGlobal,
//     describeSObject, operationStarted/Ended, cancelOperation)
//   - Feature routes registered via defineFeature()
// On success: posts `{ type: successType, data: <result + context> }`.
// On error:   posts `{ type: errorType,   data: <context + message> }`.
// Merges the original message into both responses so `opId` echoes back and
// the webview can correlate.

import * as vscode from 'vscode';
import type { ConnectionManager } from '../salesforce/connection';
import type { RestCallService } from '../services/rest/RestCallService';
import type {
  RestCallStateStore,
  HeaderEntry,
  RestCallTab,
  SavedRestCall,
} from '../services/rest/RestCallStateStore';
import type { DescribeService } from '../services/describe/DescribeService';
import type { PluginHost } from '../services/plugins/PluginHost';
import type { FeatureModule, RouteDescriptor } from '../features/FeatureModule';
import { NO_REPLY, RouteError } from '../features/FeatureModule';
import type {
  ErrorPayload,
  HostMessage,
  HostToWebviewType,
  WebviewMessage,
  WebviewToHostType,
} from '../shared/protocol';
import { buildRecordUrl } from '../utils/salesforceUrl';
import type { OperationRegistry } from './OperationRegistry';

// Narrowed to the shared contract: `handle`'s switch now only compiles against
// names that actually exist in the protocol, and `default` falls through to the
// feature route map keyed by the same union.
type IncomingMessage = WebviewMessage;

/** Owner label for a route the switch in `handle` answers itself. */
export const BUILT_IN_OWNER = '(built-in)';

/**
 * The names `handle`'s own switch answers, before a feature route is ever
 * consulted.
 *
 * Listed rather than left implicit in the switch because they are half of the
 * duplicate check: `handle` `return`s on each of these, so a FEATURE that
 * registered one would be shadowed with no symptom but a reply that never
 * arrives — the same silent no-op `src/shared/protocol` exists to eliminate,
 * and invisible to a check that only compares features to each other.
 *
 * Typed as `WebviewToHostType[]`, so deleting a name from the protocol breaks
 * this too. Keep it in step with the switch; the pair is asserted in
 * `MessageRouter.test.ts`.
 */
export const BUILT_IN_ROUTES: readonly WebviewToHostType[] = [
  'ready',
  'openRecord',
  'openExternalUrl',
  'restCall',
  'pluginInvoke',
  'loadRestCallState',
  'saveRestCallTabs',
  'addRestCallHistory',
  'saveRestCallSavedRequests',
  'describeGlobal',
  'describeSObject',
  'operationStarted',
  'operationEnded',
  'cancelOperation',
  'openInBrowser',
  'refreshOrg',
  'confirmAction',
];

interface MessageRouterDeps {
  webview: vscode.Webview;
  connectionManager: ConnectionManager;
  restCallService: RestCallService;
  restCallStateStore: RestCallStateStore;
  describeService: DescribeService;
  pluginHost: PluginHost;
  features: FeatureModule[];
  operations: OperationRegistry;
  onReady: () => Promise<void>;
}

export class MessageRouter {
  private readonly webview: vscode.Webview;
  private readonly connectionManager: ConnectionManager;
  private readonly restCallService: RestCallService;
  private readonly restCallStateStore: RestCallStateStore;
  private readonly describeService: DescribeService;
  private readonly pluginHost: PluginHost;
  private readonly operations: OperationRegistry;
  private readonly onReady: () => Promise<void>;
  // Keyed by the protocol union, not `string`: `get()` then only accepts a name
  // that exists in `WebviewToHostType`, so the guarantee the contract makes
  // survives the last hop into dispatch.
  private readonly _routeMap = new Map<WebviewToHostType, RouteDescriptor>();
  /** Feature id per claimed route, so a duplicate can name both sides. */
  private readonly _routeOwners = new Map<WebviewToHostType, string>();

  constructor(deps: MessageRouterDeps) {
    this.webview = deps.webview;
    this.connectionManager = deps.connectionManager;
    this.restCallService = deps.restCallService;
    this.restCallStateStore = deps.restCallStateStore;
    this.describeService = deps.describeService;
    this.pluginHost = deps.pluginHost;
    this.operations = deps.operations;
    this.onReady = deps.onReady;
    // Seeded FIRST, so a feature claiming a built-in name collides with it
    // rather than registering a route `handle` will never reach.
    for (const type of BUILT_IN_ROUTES) this._routeOwners.set(type, BUILT_IN_OWNER);
    for (const feature of deps.features) {
      const routes = feature.routes;
      // `Object.entries` widens the key back to `string` and, because `routes`
      // is a Partial, silently drops the `| undefined` from the value — so a
      // route explicitly set to undefined would be stored as one. Iterating the
      // keys and indexing keeps the value honest; the cast is only on the key,
      // which is where TS genuinely cannot preserve the literal union.
      for (const type of Object.keys(routes) as WebviewToHostType[]) {
        const route = routes[type];
        if (!route) continue;
        // Two claims on the same name is the one routing mistake the shared
        // protocol cannot catch — every name involved is valid, and this map is
        // the only place the collision is visible. Silently keeping one of them
        // leaves the other route dead with no symptom except a reply that never
        // arrives, which is exactly the failure mode `src/shared/protocol`
        // exists to eliminate. Fail at construction, in front of whoever just
        // added it. Covers both a second FEATURE and a built-in (seeded above),
        // which `handle` answers before any feature route is consulted.
        const owner = this._routeOwners.get(type);
        if (owner) {
          throw new Error(
            `Duplicate route "${type}": registered by both "${owner}" and "${feature.id}".`,
          );
        }
        this._routeOwners.set(type, feature.id);
        this._routeMap.set(type, route);
      }
    }
  }

  async handle(message: IncomingMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.onReady();
        return;
      case 'restCall':
        await this._routeRestCall(message);
        return;
      case 'pluginInvoke':
        await this._routePluginInvoke(message);
        return;
      case 'loadRestCallState':
        await this._route(
          async () => this.restCallStateStore.getState(),
          'restCallStateLoaded',
          'restCallStateError',
        );
        return;
      case 'saveRestCallTabs':
        // Fire-and-forget: the webview owns the authoritative copy.
        await this.restCallStateStore.saveTabs(
          message.tabs as RestCallTab[],
          message.activeTab as number,
        );
        return;
      case 'addRestCallHistory':
        await this._route(
          async () => ({
            history: await this.restCallStateStore.addHistory({
              method: message.method as string,
              endpoint: message.endpoint as string,
              body: message.body as string,
              headers: (message.headers as HeaderEntry[] | undefined) ?? [],
            }),
          }),
          'restCallHistoryUpdated',
          'restCallHistoryError',
        );
        return;
      case 'saveRestCallSavedRequests':
        await this._route(
          async () => ({
            savedRequests: await this.restCallStateStore.saveSavedRequests(
              message.savedRequests as SavedRestCall[],
            ),
          }),
          'restCallSavedRequestsUpdated',
          'restCallSavedRequestsError',
        );
        return;
      case 'describeGlobal':
        await this._route(
          () => this.describeService.describeGlobal(),
          'describeGlobalResult',
          'describeError',
        );
        return;
      case 'describeSObject':
        await this._route(
          () => this.describeService.describeSObject(message.name as string),
          'describeSObjectResult',
          'describeError',
          { name: message.name as string },
        );
        return;
      case 'operationStarted': {
        const opId = message.opId as string | undefined;
        if (opId) this.operations.startWebviewOp(opId);
        return;
      }
      case 'operationEnded': {
        this.operations.endWebviewOp(message.opId as string | undefined);
        return;
      }
      case 'cancelOperation':
        this.operations.cancelTerminalOp(message.opId as string);
        return;
      case 'openRecord': {
        const org = this.connectionManager.getCurrentOrg();
        if (org) {
          const url = buildRecordUrl(org, message.recordId as string);
          await vscode.env.openExternal(vscode.Uri.parse(url));
        }
        return;
      }
      case 'openExternalUrl': {
        const url = message.url as string;
        if (url && /^https?:\/\//i.test(url)) {
          await vscode.env.openExternal(vscode.Uri.parse(url));
        }
        return;
      }
      case 'openInBrowser':
        try {
          await vscode.commands.executeCommand('forceCockpit.openInBrowser');
        } finally {
          this._post({ type: 'openInBrowserDone' });
        }
        return;
      case 'refreshOrg':
        try {
          await vscode.commands.executeCommand('forceCockpit.refreshOrg');
        } finally {
          this._post({ type: 'refreshOrgDone' });
        }
        return;
      case 'confirmAction': {
        const answer = await vscode.window.showWarningMessage(
          message.prompt as string,
          { modal: true },
          'Execute',
        );
        this._post({
          type: 'confirmActionResult',
          data: { confirmed: answer === 'Execute', requestId: message.requestId },
        });
        return;
      }
      default:
        await this._dispatchFeatureRoute(message);
    }
  }

  /**
   * Send one REST request, tracked under the webview's `opId` so a request tab can
   * cancel it and so the reply can be matched back to the tab that started it.
   *
   * Registers the abort the same way `_dispatchFeatureRoute` does — a built-in
   * route otherwise bypasses `OperationRegistry` entirely and could not be
   * cancelled. Only `opId` is echoed as context, never the whole message: `_route`
   * merges context *over* the result, so the request's own `headers` would
   * clobber the response's.
   */
  private async _routeRestCall(message: IncomingMessage): Promise<void> {
    const opId = message.opId as string | undefined;
    const ac = opId ? this.operations.createTerminalAbort(opId) : undefined;

    await this._route(
      async () => {
        try {
          const result = await this.restCallService.send(
            message.method as string,
            message.endpoint as string,
            message.body as string,
            message.headers as HeaderEntry[] | undefined,
            ac?.signal,
          );
          // A cancelled request has no result the tab still wants; staying silent
          // also spares the webview from having to recognise an abort error.
          return ac?.signal.aborted ? NO_REPLY : result;
        } catch (err) {
          if (ac?.signal.aborted) return NO_REPLY;
          throw err;
        }
      },
      'restCallResult',
      'restCallError',
      opId ? { opId } : {},
    );

    if (opId) this.operations.endTerminalOp(opId);
  }

  /**
   * Run one plugin handler, tracked under the webview's `opId`.
   *
   * A built-in route rather than a feature route: this is infrastructure, and
   * `restCall` above is the precedent — a built-in name backed by a service.
   * It has to be, because a plugin cannot own a name in the protocol union: ALL
   * plugins share this one envelope and the `pluginId` inside it.
   *
   * Registers the abort exactly as `_routeRestCall` does, streams `log()` output
   * over the existing `scriptLogChunk` channel, and echoes ONLY `opId` as
   * context — `_route` merges context *over* the result, so the request's own
   * `args` would clobber the reply.
   */
  private async _routePluginInvoke(message: IncomingMessage): Promise<void> {
    const opId = message.opId as string | undefined;
    const ac = opId ? this.operations.createTerminalAbort(opId) : undefined;
    const onChunk = opId
      ? (chunk: string) => this._post({ type: 'scriptLogChunk', data: { opId, chunk } })
      : undefined;

    await this._route(
      async () => {
        try {
          const result = await this.pluginHost.invoke(
            message.pluginId as string,
            message.handler as string,
            message.args,
            { signal: ac?.signal, onChunk },
          );
          // A cancelled invoke has no result the panel still wants; staying
          // silent also spares the webview from recognising an abort error.
          return ac?.signal.aborted ? NO_REPLY : { result };
        } catch (err) {
          if (ac?.signal.aborted) return NO_REPLY;
          throw err;
        }
      },
      'pluginResult',
      'pluginError',
      opId ? { opId } : {},
    );

    if (opId) this.operations.endTerminalOp(opId);
  }

  /**
   * The ONE place this class talks to the webview, so every `type` is checked
   * against `HostToWebviewType`. The built-in routes used to call
   * `webview.postMessage` directly, which checks nothing at the call site.
   */
  private _post(message: HostMessage): void {
    // eslint-disable-next-line no-restricted-syntax -- the chokepoint itself
    this.webview.postMessage(message);
  }

  private async _dispatchFeatureRoute(message: IncomingMessage): Promise<void> {
    const route = this._routeMap.get(message.type);
    if (!route) return;

    const opId = message.opId as string | undefined;
    const ac = opId ? this.operations.createTerminalAbort(opId) : undefined;

    const postChunk = opId
      ? (chunk: string) => this._post({ type: 'scriptLogChunk', data: { opId, chunk } })
      : undefined;

    await this._route(
      () => route.handler(message, ac?.signal, postChunk),
      route.successType,
      route.errorType,
      message as Record<string, unknown>, // echoes opId in the response
    );

    if (opId) this.operations.endTerminalOp(opId);
  }

  /**
   * Run an action; post success/error with context merged in both branches.
   * A handler that resolves with NO_REPLY posts nothing; a RouteError carries
   * extra fields onto the error payload.
   */
  private async _route<T>(
    action: () => Promise<T>,
    successType: HostToWebviewType,
    errorType: HostToWebviewType,
    context: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      const data = await action();
      if (data === NO_REPLY) return;
      // `context` FIRST, so the route's own return value wins a name collision.
      // `_dispatchFeatureRoute` passes the whole request message as context, and
      // with the spread the other way round the request silently overwrote the
      // reply: `saveMonitoringConfig` is posted as `{ config }` and returns
      // `{ config: saved }`, so the webview received back its own unsaved draft
      // instead of the persisted record — whose `id` the host re-slugs from
      // folder + name, which is exactly the value the rename path cares about.
      // The same hazard was already fixed for `restCall` by narrowing its
      // context to `{ opId }`; that is not an option here, because the SOQL tab
      // deliberately relies on the request's `soql` riding back on `queryResult`
      // to feed the AI panel's "They ran:" block. Flipping the order keeps every
      // such echo working and changes only the collision case. It also matches
      // the error path below, which already spreads `context` first.
      const dataObj =
        typeof data === 'object' && data !== null
          ? { ...context, ...(data as Record<string, unknown>) }
          : { ...context, result: data };
      this._post({ type: successType, data: dataObj });
    } catch (err) {
      const extra = err instanceof RouteError ? err.data : {};
      const data: ErrorPayload = {
        ...context,
        ...extra,
        message: (err as Error).message,
      };
      this._post({ type: errorType, data });
    }
  }
}

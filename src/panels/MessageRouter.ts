// Routes incoming webview messages to their handlers:
//   - Built-in host routes (ready, openRecord, openInBrowser, refreshOrg,
//     confirmAction, openExternalUrl, restCall, loadRestCallState,
//     saveRestCallState, addRestCallHistory, saveRestCallSavedRequests, describeGlobal,
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
  SavedRestCall,
} from '../services/rest/RestCallStateStore';
import type { DescribeService } from '../services/describe/DescribeService';
import type { FeatureModule, RouteDescriptor } from '../features/FeatureModule';
import { NO_REPLY, RouteError } from '../features/FeatureModule';
import { buildRecordUrl } from '../utils/salesforceUrl';
import type { OperationRegistry } from './OperationRegistry';

type IncomingMessage = { type: string; [key: string]: unknown };

interface MessageRouterDeps {
  webview: vscode.Webview;
  connectionManager: ConnectionManager;
  restCallService: RestCallService;
  restCallStateStore: RestCallStateStore;
  describeService: DescribeService;
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
  private readonly operations: OperationRegistry;
  private readonly onReady: () => Promise<void>;
  private readonly _routeMap = new Map<string, RouteDescriptor>();

  constructor(deps: MessageRouterDeps) {
    this.webview = deps.webview;
    this.connectionManager = deps.connectionManager;
    this.restCallService = deps.restCallService;
    this.restCallStateStore = deps.restCallStateStore;
    this.describeService = deps.describeService;
    this.operations = deps.operations;
    this.onReady = deps.onReady;
    for (const feature of deps.features) {
      for (const [type, route] of Object.entries(feature.routes)) {
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
        await this._route(
          () =>
            this.restCallService.send(
              message.method as string,
              message.endpoint as string,
              message.body as string,
              message.headers as HeaderEntry[] | undefined,
            ),
          'restCallResult',
          'restCallError',
        );
        return;
      case 'loadRestCallState':
        await this._route(
          async () => this.restCallStateStore.getState(),
          'restCallStateLoaded',
          'restCallStateError',
        );
        return;
      case 'saveRestCallState':
        await this.restCallStateStore.save({
          method: message.method as string,
          endpoint: message.endpoint as string,
          body: message.body as string,
          headers: (message.headers as HeaderEntry[] | undefined) ?? [],
        });
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
          this.webview.postMessage({ type: 'openInBrowserDone' });
        }
        return;
      case 'refreshOrg':
        try {
          await vscode.commands.executeCommand('forceCockpit.refreshOrg');
        } finally {
          this.webview.postMessage({ type: 'refreshOrgDone' });
        }
        return;
      case 'confirmAction': {
        const answer = await vscode.window.showWarningMessage(
          message.prompt as string,
          { modal: true },
          'Execute',
        );
        this.webview.postMessage({
          type: 'confirmActionResult',
          data: { confirmed: answer === 'Execute', requestId: message.requestId },
        });
        return;
      }
      default:
        await this._dispatchFeatureRoute(message);
    }
  }

  private async _dispatchFeatureRoute(message: IncomingMessage): Promise<void> {
    const route = this._routeMap.get(message.type);
    if (!route) return;

    const opId = message.opId as string | undefined;
    const ac = opId ? this.operations.createTerminalAbort(opId) : undefined;

    const postChunk = opId
      ? (chunk: string) =>
          this.webview.postMessage({ type: 'scriptLogChunk', data: { opId, chunk } })
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
    successType: string,
    errorType: string,
    context: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      const data = await action();
      if (data === NO_REPLY) return;
      const dataObj =
        typeof data === 'object' && data !== null
          ? { ...(data as Record<string, unknown>), ...context }
          : { result: data, ...context };
      this.webview.postMessage({ type: successType, data: dataObj });
    } catch (err) {
      const extra = err instanceof RouteError ? err.data : {};
      this.webview.postMessage({
        type: errorType,
        data: { ...context, ...extra, message: (err as Error).message },
      });
    }
  }
}

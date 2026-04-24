// Routes incoming webview messages to their handlers:
//   - Built-in host routes (ready, query, openRecord, openInBrowser,
//     confirmAction, openExternalUrl, operationStarted/Ended, cancelOperation)
//   - Feature routes registered via defineFeature()
// On success: posts `{ type: successType, data: <result + context> }`.
// On error:   posts `{ type: errorType,   data: <context + message> }`.
// Merges the original message into both responses so `opId` echoes back and
// the webview can correlate.

import * as vscode from 'vscode';
import type { ConnectionManager } from '../salesforce/connection';
import type { QueryService } from '../services/QueryService';
import type { FeatureModule, RouteDescriptor } from '../features/FeatureModule';
import { buildRecordUrl } from '../utils/salesforceUrl';
import type { OperationRegistry } from './OperationRegistry';

type IncomingMessage = { type: string; [key: string]: unknown };

interface MessageRouterDeps {
  webview: vscode.Webview;
  connectionManager: ConnectionManager;
  queryService: QueryService;
  features: FeatureModule[];
  operations: OperationRegistry;
  onReady: () => Promise<void>;
}

export class MessageRouter {
  private readonly webview: vscode.Webview;
  private readonly connectionManager: ConnectionManager;
  private readonly queryService: QueryService;
  private readonly operations: OperationRegistry;
  private readonly onReady: () => Promise<void>;
  private readonly _routeMap = new Map<string, RouteDescriptor>();

  constructor(deps: MessageRouterDeps) {
    this.webview = deps.webview;
    this.connectionManager = deps.connectionManager;
    this.queryService = deps.queryService;
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
      case 'query':
        await this._route(
          () => this.queryService.runQuery(message.soql as string),
          'queryResult',
          'queryError',
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

  /** Run an action; post success/error with context merged in both branches. */
  private async _route<T>(
    action: () => Promise<T>,
    successType: string,
    errorType: string,
    context: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      const data = await action();
      const dataObj =
        typeof data === 'object' && data !== null
          ? { ...(data as Record<string, unknown>), ...context }
          : { result: data, ...context };
      this.webview.postMessage({ type: successType, data: dataObj });
    } catch (err) {
      this.webview.postMessage({
        type: errorType,
        data: { ...context, message: (err as Error).message },
      });
    }
  }
}

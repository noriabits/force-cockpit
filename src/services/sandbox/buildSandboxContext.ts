import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import xmlFormat from 'xml-formatter';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import type { ConnectionManager, DebuggingOptions } from '../../salesforce/connection';
import { runTerminalCommand } from '../../utils/terminalCommand';
import { isHttpMethod, VALID_METHODS, type RestCallService } from '../rest/RestCallService';
import { assertApexSuccess, filterUserDebugLines } from '../apex/apexUtils';
import { xml } from './XmlHelper';
import { input } from './InputHelper';
import { apexValue } from './ApexHelper';

/**
 * The globals a sandboxed user script sees. Shared by the yaml-scripts `js`
 * executor and by `PluginHost`, so the two can never disagree about what a
 * script can reach — before this existed the list lived inline in `JsExecutor`
 * and a second consumer would have meant a second copy.
 *
 * This is NOT a security boundary and is not intended as one: `fs`, `os` and
 * `run()` are handed over deliberately, and host-realm objects cross the
 * context boundary. `vm` buys scoping and `breakOnSigint`, not containment.
 * What confinement exists for destructive work is the sensitive-org gate in
 * `src/services/plugins/sensitiveGate.ts`, applied on top of this.
 */
export interface SandboxDeps {
  connectionManager: ConnectionManager;
  workspaceRoot?: string;
  restCallService?: RestCallService;
}

export interface SandboxRuntime {
  /** Cancels `run()` and `restCall()` in flight. */
  signal?: AbortSignal;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export type SandboxContext = Record<string, unknown>;

export function buildSandboxContext(deps: SandboxDeps, runtime: SandboxRuntime): SandboxContext {
  const { connectionManager, workspaceRoot, restCallService } = deps;
  const { signal, log, error } = runtime;

  return {
    connection: connectionManager.getConnection(),
    org: connectionManager.getCurrentOrg(),
    query: (soql: string) => connectionManager.query(soql),
    executeApex: (apexBody: string, options?: DebuggingOptions) =>
      connectionManager.executeAnonymousWithDebugLog(apexBody, options),
    restCall: makeRestCallFn(restCallService, signal),
    log,
    error,
    workspaceRoot,
    run: makeRunFn(workspaceRoot, signal, log),
    console: { log, error, warn: log },
    fs,
    os,
    path,
    yaml,
    xmlFormat,
    DOMParser,
    XMLSerializer,
    xml,
    input,
    xmlEscape,
    apexValue,
    assertApexSuccess,
    filterUserDebugLines,
    setTimeout,
    clearTimeout,
    Promise,
  };
}

/**
 * The `restCall()` sandbox global. Scripts could already reach REST through the
 * raw jsforce `connection`, but that path resolves only the parsed body — no
 * status, no headers — throws on any non-2xx, and misses the 401 session-refresh
 * replay. This routes through the same service the REST tab uses, so a script
 * gets the status back, can branch on a 404 without a try/catch, and survives an
 * expired overnight token.
 */
function makeRestCallFn(restCallService: RestCallService | undefined, signal?: AbortSignal) {
  return async (
    method: string,
    endpoint: string,
    body?: string | object,
    headers?: Record<string, string>,
  ) => {
    if (!restCallService) {
      throw new Error('restCall() is unavailable: no REST service configured.');
    }
    // The service silently downgrades an unrecognized verb to GET. In a script
    // that would issue a different request than the one written, so reject it.
    if (!isHttpMethod(method)) {
      throw new Error(
        `restCall(): unsupported method "${method}" (use one of ${VALID_METHODS.join(', ')})`,
      );
    }
    const entries = Object.entries(headers ?? {}).map(([key, value]) => ({
      key,
      value: String(value ?? ''),
    }));
    // An object body is the natural port from jsforce's `connection.request()`,
    // and `RestCallService.send` calls `.trim()` on what it is given — so
    // serialize it here rather than letting it throw a TypeError in the sandbox.
    const payload = body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    return restCallService.send(method, endpoint, payload, entries, signal);
  };
}

function makeRunFn(
  workspaceRoot: string | undefined,
  signal: AbortSignal | undefined,
  log: (...args: unknown[]) => void,
) {
  return (cmd: string) =>
    runTerminalCommand(cmd, workspaceRoot, signal, (chunk) => log(chunk.replace(/\n$/, '')));
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

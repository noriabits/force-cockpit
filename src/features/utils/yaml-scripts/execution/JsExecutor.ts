import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import xmlFormat from 'xml-formatter';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { createContext, Script } from 'vm';
import type { ConnectionManager, DebuggingOptions } from '../../../../salesforce/connection';
import { runTerminalCommand } from '../../../../utils/terminalCommand';
import {
  isHttpMethod,
  VALID_METHODS,
  type RestCallService,
} from '../../../../services/rest/RestCallService';
import { xml } from './XmlHelper';
import { input } from './InputHelper';
import { apexValue } from './ApexHelper';
import { assertApexSuccess, filterUserDebugLines } from '../../../apexUtils';
import type { ExecuteScriptResult, MakeRunScript, YamlScript } from '../types';

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export class JsExecutor {
  constructor(
    private readonly connectionManager: ConnectionManager,
    private readonly workspaceRoot?: string,
    private readonly restCallService?: RestCallService,
  ) {}

  /**
   * The `restCall()` sandbox global. Scripts could already reach REST through the
   * raw jsforce `connection`, but that path resolves only the parsed body — no
   * status, no headers — throws on any non-2xx, and misses the 401 session-refresh
   * replay. This routes through the same service the REST tab uses, so a script
   * gets the status back, can branch on a 404 without a try/catch, and survives an
   * expired overnight token.
   */
  private makeRestCallFn(signal: AbortSignal | undefined) {
    return async (
      method: string,
      endpoint: string,
      body?: string | object,
      headers?: Record<string, string>,
    ) => {
      if (!this.restCallService) {
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
      return this.restCallService.send(method, endpoint, payload, entries, signal);
    };
  }

  private makeRunFn(signal: AbortSignal | undefined, logFn: (...args: unknown[]) => void) {
    return (cmd: string) =>
      runTerminalCommand(cmd, this.workspaceRoot, signal, (chunk) =>
        logFn(chunk.replace(/\n$/, '')),
      );
  }

  async execute(
    script: YamlScript,
    signal?: AbortSignal,
    onLogChunk?: (chunk: string) => void,
    makeRunScript?: MakeRunScript,
  ): Promise<ExecuteScriptResult> {
    const output: string[] = [];
    const logFn = (...args: unknown[]) => {
      const line = args.map(String).join(' ');
      output.push(line);
      onLogChunk?.(line + '\n');
    };
    const errorFn = (...args: unknown[]) => {
      const line = `[ERROR] ${args.map(String).join(' ')}`;
      output.push(line);
      onLogChunk?.(line + '\n');
    };
    // Verbatim variant for text that already carries its own newlines (a called
    // script's streamed output). `logFn` would append a newline per chunk; the
    // trailing one is trimmed here because `output` is joined with '\n' below.
    const emitRaw = (text: string) => {
      output.push(text.replace(/\n$/, ''));
      onLogChunk?.(text);
    };

    const outputs: Record<string, string> = {};

    try {
      const contextObj = {
        connection: this.connectionManager.getConnection(),
        org: this.connectionManager.getCurrentOrg(),
        query: (soql: string) => this.connectionManager.query(soql),
        executeApex: (apexBody: string, options?: DebuggingOptions) =>
          this.connectionManager.executeAnonymousWithDebugLog(apexBody, options),
        restCall: this.makeRestCallFn(signal),
        log: logFn,
        error: errorFn,
        workspaceRoot: this.workspaceRoot,
        run: this.makeRunFn(signal, logFn),
        runScript: makeRunScript?.(emitRaw),
        setOutput: (name: string, value: unknown) => {
          outputs[String(name)] = String(value);
        },
        console: { log: logFn, error: errorFn, warn: logFn },
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

      const vmContext = createContext(contextObj);
      const wrapped = `(async () => { ${script.script} })()`;
      const vmScript = new Script(wrapped);
      const execution = vmScript.runInContext(vmContext, { breakOnSigint: true }) as Promise<void>;

      if (signal) {
        const abortPromise = new Promise<never>((_, reject) =>
          signal.addEventListener('abort', () => reject(new Error('Operation cancelled')), {
            once: true,
          }),
        );
        await Promise.race([execution, abortPromise]);
      } else {
        await execution;
      }

      return {
        scriptId: script.id,
        success: true,
        message: `Script "${script.name}" executed successfully.`,
        debugLog: output.join('\n'),
        outputs,
      };
    } catch (err) {
      const errorMsg = (err as Error).message;
      if (errorMsg === 'Operation cancelled') {
        return { scriptId: script.id, success: false, message: '', debugLog: '', cancelled: true };
      }
      output.push(`\n--- error ---\n${errorMsg}`);
      return {
        scriptId: script.id,
        success: false,
        message: errorMsg,
        debugLog: output.join('\n'),
        outputs,
      };
    }
  }
}

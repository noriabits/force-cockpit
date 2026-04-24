import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import xmlFormat from 'xml-formatter';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { createContext, Script } from 'vm';
import type { ConnectionManager } from '../../../../salesforce/connection';
import { xml, input } from '../scriptHelpers';
import type { ExecuteScriptResult, YamlScript } from '../types';

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export class JsExecutor {
  constructor(private readonly connectionManager: ConnectionManager) {}

  async execute(
    script: YamlScript,
    signal?: AbortSignal,
    onLogChunk?: (chunk: string) => void,
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

    try {
      const contextObj = {
        connection: this.connectionManager.getConnection(),
        org: this.connectionManager.getCurrentOrg(),
        query: (soql: string) => this.connectionManager.query(soql),
        log: logFn,
        error: errorFn,
        console: { log: logFn, error: errorFn, warn: logFn },
        fs,
        path,
        yaml,
        xmlFormat,
        DOMParser,
        XMLSerializer,
        xml,
        input,
        xmlEscape,
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
      };
    }
  }
}

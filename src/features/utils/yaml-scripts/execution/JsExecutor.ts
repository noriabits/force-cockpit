import { createContext, Script } from 'vm';
import type { ConnectionManager } from '../../../../salesforce/connection';
import type { RestCallService } from '../../../../services/rest/RestCallService';
import { buildSandboxContext } from '../../../../services/sandbox/buildSandboxContext';
import type { ExecuteScriptResult, MakeRunScript, YamlScript } from '../types';

export class JsExecutor {
  constructor(
    private readonly connectionManager: ConnectionManager,
    private readonly workspaceRoot?: string,
    private readonly restCallService?: RestCallService,
  ) {}

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
        // The shared globals — see services/sandbox/buildSandboxContext.ts.
        // PluginHost builds from the same list, so the two cannot drift.
        ...buildSandboxContext(
          {
            connectionManager: this.connectionManager,
            workspaceRoot: this.workspaceRoot,
            restCallService: this.restCallService,
          },
          { signal, log: logFn, error: errorFn },
        ),
        // yaml-scripts-only: cross-script calls and the `::fc-output` equivalent.
        runScript: makeRunScript?.(emitRaw),
        setOutput: (name: string, value: unknown) => {
          outputs[String(name)] = String(value);
        },
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

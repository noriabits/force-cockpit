import { runTerminalCommand } from '../../../../utils/terminalCommand';
import type { ExecuteScriptResult, YamlScript } from '../types';

export class CommandExecutor {
  constructor(private readonly workspaceRoot: string) {}

  async execute(
    script: YamlScript,
    signal?: AbortSignal,
    onLogChunk?: (chunk: string) => void,
  ): Promise<ExecuteScriptResult> {
    const result = await runTerminalCommand(
      script.script,
      this.workspaceRoot || undefined,
      signal,
      onLogChunk,
    );
    if (result.cancelled) {
      return { scriptId: script.id, success: false, message: '', debugLog: '', cancelled: true };
    }
    return {
      scriptId: script.id,
      success: result.success,
      message: result.success
        ? `Command "${script.name}" completed successfully.`
        : `Command failed`,
      debugLog: result.output,
    };
  }
}

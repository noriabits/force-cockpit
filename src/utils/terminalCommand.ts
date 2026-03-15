import { spawn } from 'child_process';

export interface TerminalCommandResult {
  success: boolean;
  output: string;
  cancelled?: boolean;
}

/**
 * Run a shell command in the given working directory.
 * Captures stdout and stderr; appends stderr with a separator if non-empty.
 * Pass an AbortSignal to kill the process and resolve with { cancelled: true }.
 */
export function runTerminalCommand(
  command: string,
  workspaceRoot?: string,
  signal?: AbortSignal,
): Promise<TerminalCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [], {
      shell: true,
      cwd: workspaceRoot || undefined,
    });

    let settled = false;
    const done = (result: TerminalCommandResult) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          child.kill();
          done({ success: false, output: '', cancelled: true });
        },
        { once: true },
      );
    }

    const stdout: string[] = [];
    const stderr: string[] = [];

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));

    child.on('error', (err: Error) => {
      done({ success: false, output: err.message });
    });

    child.on('close', (code: number | null) => {
      const output = [
        stdout.join(''),
        stderr.length ? `\n--- stderr ---\n${stderr.join('')}` : '',
      ].join('');
      done({ success: code === 0, output });
    });
  });
}

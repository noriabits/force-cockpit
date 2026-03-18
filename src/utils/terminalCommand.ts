import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
  onOutput?: (chunk: string) => void,
): Promise<TerminalCommandResult> {
  const isWindows = process.platform === 'win32';
  const ext = isWindows ? '.cmd' : '.sh';
  const tmpFile = path.join(os.tmpdir(), `fc-script-${Date.now()}${ext}`);
  fs.writeFileSync(tmpFile, command, 'utf8');
  if (!isWindows) {
    fs.chmodSync(tmpFile, 0o755);
  }

  const spawnCmd = isWindows ? 'cmd' : 'sh';
  const spawnArgs = isWindows ? ['/c', tmpFile] : [tmpFile];

  return new Promise((resolve) => {
    const child = spawn(spawnCmd, spawnArgs, {
      cwd: workspaceRoot || undefined,
    });

    let settled = false;
    const done = (result: TerminalCommandResult) => {
      if (!settled) {
        settled = true;
        try {
          fs.unlinkSync(tmpFile);
        } catch {
          /* ignore */
        }
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

    child.stdout?.on('data', (chunk: Buffer) => {
      const s = chunk.toString();
      stdout.push(s);
      onOutput?.(s);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const s = chunk.toString();
      stderr.push(s);
      onOutput?.(s);
    });

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

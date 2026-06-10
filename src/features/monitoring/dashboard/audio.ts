import * as cp from 'child_process';
import type * as vscode from 'vscode';

interface PingCommand {
  command: string;
  args: string[];
}

function pickPingCommand(): PingCommand {
  switch (process.platform) {
    case 'darwin':
      return { command: 'afplay', args: ['/System/Library/Sounds/Glass.aiff'] };
    case 'win32':
      return {
        command: 'powershell.exe',
        args: ['-NoProfile', '-Command', '[console]::beep(880,300)'],
      };
    default:
      return {
        command: 'paplay',
        args: ['/usr/share/sounds/freedesktop/stereo/message.oga'],
      };
  }
}

/**
 * Best-effort OS-level audio cue for row-count-grew notifications. Failures
 * (binary missing, audio device unavailable) are swallowed — caller never sees
 * an error. The child process is detached + unref'd so it can't keep Node alive.
 */
export function playRowCountPing(outputChannel?: vscode.OutputChannel): void {
  try {
    const { command, args } = pickPingCommand();
    const proc = cp.spawn(command, args, { detached: true, stdio: 'ignore' });
    proc.on('error', () => {
      // Swallow ENOENT and similar — audio is best-effort
    });
    proc.unref();
  } catch (err) {
    outputChannel?.appendLine(`[Debug] Audio ping failed: ${String(err)}`);
  }
}

import * as cp from 'child_process';
import type * as vscode from 'vscode';

interface PingCommand {
  command: string;
  args: string[];
}

/**
 * Plays a real WAV through the sound card via System.Media.SoundPlayer.
 *
 * NOT `[console]::beep` — that targets the console device (we spawn with
 * `stdio: 'ignore'`, so there is none and .NET throws) and routes through the
 * `beep.sys` PC-speaker driver, which is disabled or absent on many machines.
 *
 * `$ErrorActionPreference = 'Stop'` is load-bearing, not decoration: PowerShell's
 * non-terminating errors leave the exit code at 0, so a failed `New-Object` would
 * look like success and the candidate chain would never advance. Promoting every
 * error to terminating is what makes a Windows failure observable to `tryCandidates`.
 *
 * The `Add-Type` line is only for `pwsh` (PowerShell 7): SoundPlayer lives in
 * System.dll on .NET Framework (always loaded in Windows PowerShell 5.1) but moved
 * to System.Windows.Extensions on .NET Core. `-ErrorAction SilentlyContinue`
 * overrides the preference above, so 5.1 — where the assembly does not exist and
 * is not needed — ignores it.
 *
 * Written with single quotes only: the whole script travels as ONE argv element,
 * and libuv wraps any argument containing spaces in double quotes — an inner `"`
 * would have to be escaped and PowerShell's own parser makes that fragile.
 */
const WINDOWS_PING_SCRIPT = [
  "$ErrorActionPreference = 'Stop';",
  'Add-Type -AssemblyName System.Windows.Extensions -ErrorAction SilentlyContinue;',
  "$m = Join-Path $env:WINDIR 'Media';",
  "$f = @('Windows Notify System Generic.wav', 'notify.wav', 'ding.wav')",
  '| ForEach-Object { Join-Path $m $_ }',
  '| Where-Object { Test-Path $_ }',
  '| Select-Object -First 1;',
  'if ($f) { (New-Object Media.SoundPlayer $f).PlaySync() }',
  'else { [System.Media.SystemSounds]::Asterisk.Play(); Start-Sleep -Milliseconds 600 }',
].join(' ');

const WINDOWS_PS_ARGS = ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PING_SCRIPT];

const FREEDESKTOP_MESSAGE = '/usr/share/sounds/freedesktop/stereo/message.oga';

/**
 * Ordered fallbacks — the first one that spawns AND exits 0 wins; the rest only
 * run if it failed, so exactly one sound is ever heard. Each list is as long as
 * the platform's real failure modes and no longer.
 *
 * macOS gets a single entry on purpose: `/System/Library/Sounds` lives on the
 * Signed System Volume (Big Sur+), which is sealed and read-only, so Glass.aiff
 * cannot be missing on a machine that boots. A second `afplay` line would be
 * unreachable and would imply a fragility that does not exist.
 */
function pingCandidates(): PingCommand[] {
  switch (process.platform) {
    case 'darwin':
      return [{ command: 'afplay', args: ['/System/Library/Sounds/Glass.aiff'] }];
    case 'win32':
      return [
        { command: 'powershell.exe', args: WINDOWS_PS_ARGS },
        { command: 'pwsh', args: WINDOWS_PS_ARGS },
      ];
    default:
      return [
        { command: 'paplay', args: [FREEDESKTOP_MESSAGE] },
        { command: 'pw-play', args: [FREEDESKTOP_MESSAGE] },
        { command: 'canberra-gtk-play', args: ['-i', 'message'] },
      ];
  }
}

/**
 * `detached` means "new process group" on POSIX (so the sound survives a parent
 * exit) but "new console window" on Windows — the wrong thing there, and the
 * reason `windowsHide` is set. `unref()` alone already keeps Node from waiting.
 */
function spawnOptions(): cp.SpawnOptions {
  return {
    detached: process.platform !== 'win32',
    stdio: 'ignore',
    windowsHide: true,
  };
}

function tryCandidates(
  candidates: PingCommand[],
  index: number,
  outputChannel?: vscode.OutputChannel,
): void {
  if (index >= candidates.length) {
    outputChannel?.appendLine('[Monitoring] Audio ping: no working player found on this platform');
    return;
  }

  const { command, args } = candidates[index];
  const next = (): void => tryCandidates(candidates, index + 1, outputChannel);

  try {
    const proc = cp.spawn(command, args, spawnOptions());
    // `error` (ENOENT) and `exit` can both fire; only advance once.
    let advanced = false;
    const advance = (): void => {
      if (advanced) return;
      advanced = true;
      next();
    };
    proc.on('error', advance);
    proc.on('exit', (code) => {
      if (code !== 0) advance();
    });
    proc.unref();
  } catch (err) {
    outputChannel?.appendLine(`[Monitoring] Audio ping via ${command} failed: ${String(err)}`);
    next();
  }
}

/**
 * Best-effort OS-level audio cue for row-count-grew notifications. Every failure
 * (binary missing, audio device unavailable, non-zero exit) falls through to the
 * next candidate; the caller never sees an error. Child processes are unref'd so
 * they can't keep Node alive.
 */
export function playRowCountPing(outputChannel?: vscode.OutputChannel): void {
  tryCandidates(pingCandidates(), 0, outputChannel);
}

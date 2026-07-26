import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
vi.mock('child_process', () => ({ spawn: spawnMock }));

vi.mock('vscode', () => ({}));

type AudioModule = typeof import('./audio');

function fakeProc() {
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  return {
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      handlers[event] = handlers[event] || [];
      handlers[event].push(cb);
    }),
    unref: vi.fn(),
    /** Test helper to fire an event */
    emit: (event: string, ...args: unknown[]) => {
      (handlers[event] || []).forEach((cb) => cb(...args));
    },
  };
}

describe('playRowCountPing', () => {
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    spawnMock.mockReset();
    spawnMock.mockReturnValue(fakeProc());
  });

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  });

  function setPlatform(value: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value, configurable: true });
  }

  it('on macOS spawns afplay with the Glass system sound', async () => {
    setPlatform('darwin');
    const { playRowCountPing } = (await import('./audio')) as AudioModule;
    playRowCountPing();
    expect(spawnMock).toHaveBeenCalledWith(
      'afplay',
      ['/System/Library/Sounds/Glass.aiff'],
      expect.objectContaining({ detached: true, stdio: 'ignore', windowsHide: true }),
    );
  });

  it('on Windows plays a WAV through SoundPlayer, never [console]::beep', async () => {
    setPlatform('win32');
    const { playRowCountPing } = (await import('./audio')) as AudioModule;
    playRowCountPing();

    const [command, args] = spawnMock.mock.calls[0];
    expect(command).toBe('powershell.exe');
    expect(args).toEqual(['-NoProfile', '-NonInteractive', '-Command', expect.any(String)]);

    const script = args[3] as string;
    // Console.Beep needs a console (we spawn with stdio: 'ignore') and routes
    // through the PC-speaker driver — this is the bug that made Windows silent.
    expect(script).not.toContain('console]::beep');
    expect(script).toContain('Media.SoundPlayer');
    expect(script).toContain('PlaySync');
    // A double quote here would have to survive libuv quoting + PowerShell parsing.
    expect(script).not.toContain('"');
  });

  it("promotes PowerShell errors to terminating so a failure reaches the chain's exit-code check", async () => {
    setPlatform('win32');
    const { playRowCountPing } = (await import('./audio')) as AudioModule;
    playRowCountPing();
    const script = spawnMock.mock.calls[0][1][3] as string;
    // Without this, a non-terminating error still exits 0 and tryCandidates
    // would treat a silent failure as success and never fall through.
    expect(script).toContain("$ErrorActionPreference = 'Stop'");
    // ...but the pwsh-only assembly probe must stay opt-out, since Windows
    // PowerShell 5.1 has no System.Windows.Extensions and does not need it.
    expect(script).toContain(
      'Add-Type -AssemblyName System.Windows.Extensions -ErrorAction SilentlyContinue',
    );
  });

  it('on Windows does not detach (that means "new console window" there) and hides the window', async () => {
    setPlatform('win32');
    const { playRowCountPing } = (await import('./audio')) as AudioModule;
    playRowCountPing();
    expect(spawnMock).toHaveBeenCalledWith(
      'powershell.exe',
      expect.any(Array),
      expect.objectContaining({ detached: false, stdio: 'ignore', windowsHide: true }),
    );
  });

  it('on Linux spawns paplay with the freedesktop message sound', async () => {
    setPlatform('linux');
    const { playRowCountPing } = (await import('./audio')) as AudioModule;
    playRowCountPing();
    expect(spawnMock).toHaveBeenCalledWith(
      'paplay',
      ['/usr/share/sounds/freedesktop/stereo/message.oga'],
      expect.objectContaining({ detached: true, stdio: 'ignore', windowsHide: true }),
    );
  });

  it('falls through to the next candidate when the binary is missing (ENOENT)', async () => {
    setPlatform('linux');
    const first = fakeProc();
    const second = fakeProc();
    spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second);

    const { playRowCountPing } = (await import('./audio')) as AudioModule;
    playRowCountPing();
    expect(spawnMock).toHaveBeenCalledTimes(1);

    first.emit('error', new Error('ENOENT'));
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[1][0]).toBe('pw-play');
  });

  it('falls through when the player spawns but exits non-zero', async () => {
    setPlatform('linux');
    const first = fakeProc();
    spawnMock.mockReturnValueOnce(first);

    const { playRowCountPing } = (await import('./audio')) as AudioModule;
    playRowCountPing();
    first.emit('exit', 1);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[1][0]).toBe('pw-play');
  });

  it('does not advance twice when both error and exit fire', async () => {
    setPlatform('linux');
    const first = fakeProc();
    spawnMock.mockReturnValueOnce(first);

    const { playRowCountPing } = (await import('./audio')) as AudioModule;
    playRowCountPing();
    first.emit('error', new Error('ENOENT'));
    first.emit('exit', 1);

    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('stops after the last candidate and does not throw', async () => {
    setPlatform('win32');
    const procs = [fakeProc(), fakeProc()];
    spawnMock.mockReturnValueOnce(procs[0]).mockReturnValueOnce(procs[1]);
    const appendLine = vi.fn();

    const { playRowCountPing } = (await import('./audio')) as AudioModule;
    playRowCountPing({ appendLine } as any);
    procs[0].emit('error', new Error('ENOENT'));
    expect(() => procs[1].emit('error', new Error('ENOENT'))).not.toThrow();

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(appendLine).toHaveBeenCalledWith(expect.stringContaining('no working player found'));
  });

  it('plays exactly one sound — a clean exit ends the chain', async () => {
    setPlatform('linux');
    const first = fakeProc();
    spawnMock.mockReturnValueOnce(first);

    const { playRowCountPing } = (await import('./audio')) as AudioModule;
    playRowCountPing();
    first.emit('exit', 0);

    // The remaining Linux candidates are fallbacks, not a playlist.
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('offers a single macOS candidate — the sealed system volume cannot lose Glass.aiff', async () => {
    setPlatform('darwin');
    const proc = fakeProc();
    spawnMock.mockReturnValueOnce(proc);

    const { playRowCountPing } = (await import('./audio')) as AudioModule;
    playRowCountPing();
    proc.emit('error', new Error('ENOENT'));

    // A second afplay entry would be unreachable dead code on Big Sur+.
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('swallows spawn errors (ENOENT etc.) — does not throw', async () => {
    setPlatform('linux');
    const proc = fakeProc();
    spawnMock.mockReturnValue(proc);
    const { playRowCountPing } = (await import('./audio')) as AudioModule;
    expect(() => playRowCountPing()).not.toThrow();
    // Fire the error event after the helper returns — must be handled
    expect(() => proc.emit('error', new Error('ENOENT'))).not.toThrow();
  });

  it('logs to outputChannel and moves on when spawn itself throws', async () => {
    setPlatform('linux');
    spawnMock.mockImplementation(() => {
      throw new Error('boom');
    });
    const appendLine = vi.fn();
    const { playRowCountPing } = (await import('./audio')) as AudioModule;
    playRowCountPing({ appendLine } as any);
    expect(appendLine).toHaveBeenCalledWith(
      expect.stringContaining('Audio ping via paplay failed'),
    );
    // All three Linux candidates attempted, then the exhausted-chain log.
    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(appendLine).toHaveBeenCalledWith(expect.stringContaining('no working player found'));
  });
});

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
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    );
  });

  it('on Windows spawns powershell beep', async () => {
    setPlatform('win32');
    const { playRowCountPing } = (await import('./audio')) as AudioModule;
    playRowCountPing();
    expect(spawnMock).toHaveBeenCalledWith(
      'powershell.exe',
      ['-NoProfile', '-Command', '[console]::beep(880,300)'],
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    );
  });

  it('on Linux spawns paplay with the freedesktop message sound', async () => {
    setPlatform('linux');
    const { playRowCountPing } = (await import('./audio')) as AudioModule;
    playRowCountPing();
    expect(spawnMock).toHaveBeenCalledWith(
      'paplay',
      ['/usr/share/sounds/freedesktop/stereo/message.oga'],
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    );
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

  it('logs to outputChannel when spawn itself throws', async () => {
    setPlatform('linux');
    spawnMock.mockImplementation(() => {
      throw new Error('boom');
    });
    const appendLine = vi.fn();
    const { playRowCountPing } = (await import('./audio')) as AudioModule;
    playRowCountPing({ appendLine } as any);
    expect(appendLine).toHaveBeenCalledWith(expect.stringContaining('Audio ping failed'));
  });
});

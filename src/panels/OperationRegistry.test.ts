import { describe, expect, it } from 'vitest';
import { OperationRegistry } from './OperationRegistry';

describe('OperationRegistry', () => {
  describe('terminal ops', () => {
    it('createTerminalAbort returns a non-aborted controller', () => {
      const reg = new OperationRegistry();
      const ac = reg.createTerminalAbort('op1');
      expect(ac).toBeInstanceOf(AbortController);
      expect(ac.signal.aborted).toBe(false);
    });

    it('cancelTerminalOp aborts the signal exactly once and forgets the op', () => {
      const reg = new OperationRegistry();
      const ac = reg.createTerminalAbort('op1');
      let abortCount = 0;
      ac.signal.addEventListener('abort', () => abortCount++);

      reg.cancelTerminalOp('op1');
      expect(ac.signal.aborted).toBe(true);
      expect(abortCount).toBe(1);

      // Second cancel is a no-op (op already removed) — no further abort events
      reg.cancelTerminalOp('op1');
      expect(abortCount).toBe(1);
    });

    it('endTerminalOp removes the op without aborting it', () => {
      const reg = new OperationRegistry();
      const ac = reg.createTerminalAbort('op1');
      reg.endTerminalOp('op1');
      // A subsequent cancel cannot abort it because it was already removed
      reg.cancelTerminalOp('op1');
      expect(ac.signal.aborted).toBe(false);
    });

    it('cancelTerminalOp on an unknown op is a no-op', () => {
      const reg = new OperationRegistry();
      expect(() => reg.cancelTerminalOp('nope')).not.toThrow();
    });
  });

  describe('webview ops + hasActive', () => {
    it('hasActive is false with no webview ops', () => {
      const reg = new OperationRegistry();
      expect(reg.hasActive).toBe(false);
    });

    it('terminal ops alone do not make hasActive true', () => {
      const reg = new OperationRegistry();
      reg.createTerminalAbort('t1');
      expect(reg.hasActive).toBe(false);
    });

    it('hasActive becomes true while a webview op is in flight', () => {
      const reg = new OperationRegistry();
      reg.startWebviewOp('w1');
      expect(reg.hasActive).toBe(true);
      reg.endWebviewOp('w1');
      expect(reg.hasActive).toBe(false);
    });

    it('endWebviewOp with no arg bulk-clears all webview ops', () => {
      const reg = new OperationRegistry();
      reg.startWebviewOp('w1');
      reg.startWebviewOp('w2');
      reg.endWebviewOp();
      expect(reg.hasActive).toBe(false);
    });

    it('tracks webview ops as a set — duplicate adds collapse', () => {
      const reg = new OperationRegistry();
      reg.startWebviewOp('w1');
      reg.startWebviewOp('w1');
      reg.endWebviewOp('w1');
      expect(reg.hasActive).toBe(false);
    });
  });

  describe('cancelAll', () => {
    it('aborts every terminal op and clears webview ops', () => {
      const reg = new OperationRegistry();
      const a = reg.createTerminalAbort('t1');
      const b = reg.createTerminalAbort('t2');
      reg.startWebviewOp('w1');

      reg.cancelAll();

      expect(a.signal.aborted).toBe(true);
      expect(b.signal.aborted).toBe(true);
      expect(reg.hasActive).toBe(false);
      // Terminal ops are forgotten — a later cancel does nothing new
      expect(() => reg.cancelTerminalOp('t1')).not.toThrow();
    });
  });
});

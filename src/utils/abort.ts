// AbortSignal helpers shared by every cancellable path (AI conversations, YAML
// script steps, SOQL queries). Kept vscode-free so they stay trivially testable.

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('Operation cancelled');
}

/**
 * Resolve/reject with `promise`, but reject immediately with 'Operation
 * cancelled' if `signal` aborts first. The in-flight work (a network request
 * or the LM stream, neither of which can be force-killed) is left to settle in
 * the background — racing it lets the run stop the instant the user cancels.
 */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error('Operation cancelled'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('Operation cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    promise.then(
      (v) => {
        cleanup();
        resolve(v);
      },
      (e) => {
        cleanup();
        reject(e);
      },
    );
  });
}

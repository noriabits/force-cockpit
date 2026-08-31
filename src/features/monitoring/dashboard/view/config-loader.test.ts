// @vitest-environment jsdom
//
// Pins WHICH branches of the delete reply settle the form's pending entry.
//
// This is the seam the "one-shot entry" contract is easiest to break at, and it
// was broken here: the confirmed branch leaned on the drain in
// `onConfigsLoaded` instead of settling, so a reload that came back
// `loadMonitoringConfigsError` — which leaves the grid and the form standing by
// design — left an entry armed for a request that had already finished. Nothing
// misrouted (entries are keyed by `requestId`, so a finished one can never be
// claimed by a later reply), but the invariant `armReply` documents was not
// actually true, and the asymmetry with `onSaveResult` was unexplained.
import { describe, expect, it, vi } from 'vitest';
import { createConfigLoader } from './config-loader';

function makeLoader() {
  const settle = vi.fn();
  const fail = vi.fn();
  const drainEditForms = vi.fn();
  const postMessage = vi.fn();
  const resolveReply = vi.fn((requestId: unknown) =>
    requestId === 'req-1' ? { settle, fail } : undefined,
  );
  const loadErrorEl = document.createElement('div');
  const loader = createConfigLoader({
    labels: { btnRestoreHidden: (n: number) => `Restore (${n})` },
    vscode: { postMessage },
    loadErrorEl,
    monitoringPanel: document.createElement('div'),
    drainEditForms,
    resolveReply,
    applyConfigs: vi.fn(),
  } as never);
  return { loader, settle, fail, drainEditForms, postMessage, loadErrorEl };
}

describe('onDeleteResult settles on both branches', () => {
  it('a CONFIRMED delete settles, then asks for the reload', () => {
    // The regression: this branch used to settle nothing, so if the reload it
    // requests fails, the entry outlives its request.
    const { loader, settle, postMessage, drainEditForms } = makeLoader();
    loader.onDeleteResult({ deleted: true, requestId: 'req-1' });

    expect(settle).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({ type: 'loadMonitoringConfigs' });
    // Settling is not draining — the reload may fail and leave the form up.
    expect(drainEditForms).not.toHaveBeenCalled();
  });

  it('a DISMISSED delete settles and asks for nothing', () => {
    const { loader, settle, postMessage, drainEditForms } = makeLoader();
    loader.onDeleteResult({ deleted: false, requestId: 'req-1' });

    expect(settle).toHaveBeenCalledTimes(1);
    expect(postMessage).not.toHaveBeenCalled();
    expect(drainEditForms).not.toHaveBeenCalled();
  });

  it('tolerates a reply with no id, and never settles someone else', () => {
    const { loader, settle } = makeLoader();
    loader.onDeleteResult({ deleted: true, requestId: 'req-other' });
    loader.onDeleteResult(undefined);
    expect(settle).not.toHaveBeenCalled();
  });
});

describe('onDeleteError', () => {
  it('delivers to the form that asked', () => {
    const { loader, fail } = makeLoader();
    loader.onDeleteError({ message: 'boom', requestId: 'req-1' });
    expect(fail).toHaveBeenCalledWith('boom');
  });

  it('falls back to the grid-level box when nothing is waiting on it', () => {
    // The form was cancelled or rebuilt away; the message must not vanish.
    const { loader, fail, loadErrorEl } = makeLoader();
    loader.onDeleteError({ message: 'boom', requestId: 'req-gone' });
    expect(fail).not.toHaveBeenCalled();
    expect(loadErrorEl.textContent).toBe('boom'); // surfaced, not swallowed
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listeners: Array<() => void> = [];
const onDidChangeChatModels = vi.fn((listener: () => void) => {
  listeners.push(listener);
  return { dispose: vi.fn() };
});
vi.mock('vscode', () => ({
  lm: {
    onDidChangeChatModels: (listener: () => void) => onDidChangeChatModels(listener),
  },
}));

import { registerChatModelWatcher, type ChatModelWatcherDeps } from './ChatModelWatcher';
import type { ChatModelInfo } from './types';

const MODELS: ChatModelInfo[] = [
  { id: 'auto', vendor: 'copilot', family: 'auto', name: 'Auto', maxInputTokens: 1000 },
];

function makeWatcher(overrides: Partial<ChatModelWatcherDeps> = {}) {
  const post = vi.fn();
  const log = vi.fn();
  const listModels = vi.fn(async () => MODELS);
  const disposable = registerChatModelWatcher({
    gateway: { listModels },
    post,
    isPanelOpen: () => true,
    log,
    ...overrides,
  });
  return { post, log, listModels, disposable };
}

/** Fire the LM event and let the debounce elapse plus any queued microtasks. */
async function fireAndSettle(times = 1, advanceMs = 400) {
  for (let i = 0; i < times; i++) listeners.forEach((l) => l());
  await vi.advanceTimersByTimeAsync(advanceMs);
}

describe('registerChatModelWatcher', () => {
  beforeEach(() => {
    listeners.length = 0;
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('posts a refreshed list as listChatModelsResult, the type every picker already handles', async () => {
    const { post, disposable } = makeWatcher();
    await fireAndSettle();
    expect(post).toHaveBeenCalledWith({ type: 'listChatModelsResult', data: { models: MODELS } });
    disposable.dispose();
  });

  it('collapses a burst of events into a single refresh', async () => {
    // Copilot re-registers repeatedly as it resolves; without the debounce each
    // fire would cost a selectChatModels() round-trip and four <select> rebuilds.
    const { post, listModels, disposable } = makeWatcher();
    await fireAndSettle(5);
    expect(listModels).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
    disposable.dispose();
  });

  it('does nothing while the panel is closed', async () => {
    const { post, listModels, disposable } = makeWatcher({ isPanelOpen: () => false });
    await fireAndSettle();
    expect(listModels).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    disposable.dispose();
  });

  it('logs but never posts when listing fails, so a transient error cannot empty the pickers', async () => {
    const listModels = vi.fn(async () => {
      throw new Error('Copilot unavailable');
    });
    const { post, log, disposable } = makeWatcher({ gateway: { listModels } });
    await fireAndSettle();
    expect(post).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Copilot unavailable'));
    disposable.dispose();
  });

  it('does not fire a pending refresh after disposal', async () => {
    const { post, disposable } = makeWatcher();
    listeners.forEach((l) => l());
    disposable.dispose();
    await vi.advanceTimersByTimeAsync(400);
    expect(post).not.toHaveBeenCalled();
  });

  it('honours a custom debounce window', async () => {
    const { post, disposable } = makeWatcher({ debounceMs: 50 });
    listeners.forEach((l) => l());
    await vi.advanceTimersByTimeAsync(49);
    expect(post).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(post).toHaveBeenCalledTimes(1);
    disposable.dispose();
  });
});

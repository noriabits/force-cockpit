// Keeps the webview model pickers current. Every AI surface asks the host for
// models exactly once (Ask AI only on `orgConnected`), so a list that resolves
// after that question — Copilot signing in, a BYOK key being added, an
// entitlement changing — used to leave the picker stale until the org was
// reconnected or the panel reopened.
//
// The refresh reuses the ordinary `listChatModelsResult` message rather than
// inventing a push-only type: every picker already handles it, and since
// media/main.js fans each message out to BOTH the module and feature buses, one
// post reaches all four surfaces with no consumer-side changes.
import * as vscode from 'vscode';
import type { LmGateway } from './types';
import type { HostMessage } from '../../shared/protocol';

export interface ChatModelWatcherDeps {
  gateway: Pick<LmGateway, 'listModels'>;
  /** Delivers to the webview; a no-op when the panel is closed. */
  post: (message: HostMessage) => void;
  isPanelOpen: () => boolean;
  log?: (message: string) => void;
  /** Trailing debounce window. Copilot fires the event repeatedly as it registers. */
  debounceMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 400;

export function registerChatModelWatcher(deps: ChatModelWatcherDeps): vscode.Disposable {
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const refresh = async (): Promise<void> => {
    // Nothing to update with the panel closed, and re-opening it re-queries via
    // the ready → orgConnected path anyway.
    if (!deps.isPanelOpen()) return;
    try {
      const models = await deps.gateway.listModels();
      deps.post({ type: 'listChatModelsResult', data: { models } });
    } catch (err) {
      // Deliberately silent towards the webview: posting listChatModelsError
      // would make all four pickers call setModels([]) and wipe a good list
      // over a transient failure. A background refresh must never empty a
      // picker — the user still has whatever was there before.
      deps.log?.(`[Warn] Model list refresh failed: ${String(err)}`);
    }
  };

  const subscription = vscode.lm.onDidChangeChatModels(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void refresh();
    }, debounceMs);
  });

  return {
    dispose: () => {
      // Clear the timer as well as the subscription, so a pending refresh
      // cannot fire against a disposed panel.
      if (timer) clearTimeout(timer);
      timer = undefined;
      subscription.dispose();
    },
  };
}

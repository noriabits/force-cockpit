// The shared model-driving loop: stream the model's answer, run any tool it
// proposes, feed the result back, repeat until it stops calling tools. Kept
// vscode-free (the gateway is injected) so every consumer stays unit-testable
// with a fake gateway. Used by yaml-scripts' AiExecutor and the debug-log
// analyzer.
import type { ChatMessage, LmGateway, ToolCall } from './types';
import type { ToolHandler } from './tools/ToolHandler';
import { raceAbort, throwIfAborted } from '../../utils/abort';

// Re-exported for the AI call sites that have always imported them from here.
export { raceAbort, throwIfAborted };

export const DEFAULT_MAX_TOOL_ROUNDS = 150;

/** Details of a model fallback, surfaced to the user when it happens. */
export interface ModelFallback {
  requestedId: string;
  usedModelName: string;
}

export interface AiConversationRequest {
  /** Preferred model id; the gateway falls back to another model when it is gone. */
  modelId?: string;
  /** Conversation so far; mutated in place as the loop appends turns. */
  messages: ChatMessage[];
  /** Tools the model may call this run. Only these names are dispatchable. */
  tools: ToolHandler[];
  /** Writes model text and tool progress into the run transcript. */
  append: (s: string) => void;
  signal?: AbortSignal;
  /** Fired once, as soon as a model fallback is detected. */
  onModelFallback?: (fallback: ModelFallback) => void;
  maxToolRounds?: number;
}

export class AiConversation {
  constructor(private readonly gateway: LmGateway) {}

  /** Drive the model to a final answer. Resolves with the fallback, if one happened. */
  async run(req: AiConversationRequest): Promise<{ fallback?: ModelFallback }> {
    const { messages, append, signal } = req;
    const maxRounds = req.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
    const toolsByName = new Map(req.tools.map((t) => [t.spec.name, t]));
    const toolSpecs = req.tools.map((t) => t.spec);
    let fallback: ModelFallback | undefined;

    for (let round = 0; round < maxRounds; round++) {
      throwIfAborted(signal);

      let assistantText = '';
      const toolCalls: ToolCall[] = [];
      // Drive the iterator manually and race each step against the signal so a
      // cancel stops us mid-stream immediately, rather than waiting for the next
      // chunk (Copilot cancellation is cooperative). The gateway already cancels
      // its own CancellationToken via `signal`; `iterator.return()` lets its
      // `finally` run if we bail out early.
      const iterator = this.gateway
        .send({ modelId: req.modelId, messages, tools: toolSpecs }, signal)
        [Symbol.asyncIterator]();
      try {
        while (true) {
          const { value: event, done } = await raceAbort(iterator.next(), signal);
          if (done) break;
          if (event.kind === 'text') {
            assistantText += event.text;
            append(event.text);
          } else if (event.kind === 'toolCall') {
            toolCalls.push(event.call);
          } else {
            // modelFallback — the gateway re-resolves every round, so it fires
            // repeatedly; warn the user only once.
            if (!fallback) {
              fallback = { requestedId: event.requestedId, usedModelName: event.usedModelName };
              // Notify the host immediately (before the analysis runs) so it can
              // surface a toast while the run is still cancellable.
              req.onModelFallback?.(fallback);
              append(
                `⚠ The model "${event.requestedId}" chosen for this script is no longer ` +
                  `available. Using "${event.usedModelName}" instead.\n\n`,
              );
            }
          }
        }
      } finally {
        // Fire-and-forget cleanup: signal `return()` so the generator runs its
        // own `finally` (the gateway disposes its CancellationTokenSource), but
        // don't await it — a cancelled stream may not settle promptly, and the
        // whole point is to stop now. The signal is already wired into the
        // gateway's token, so the LM request is cancelled regardless.
        void Promise.resolve(iterator.return?.(undefined)).catch(() => {});
      }

      messages.push({
        role: 'assistant',
        text: assistantText,
        ...(toolCalls.length ? { toolCalls } : {}),
      });

      if (toolCalls.length === 0) return { fallback };

      for (const call of toolCalls) {
        throwIfAborted(signal);
        const handler = toolsByName.get(call.name);
        const result = handler
          ? await raceAbort(Promise.resolve(handler.run(call.input, append)), signal)
          : `Error: unknown tool "${call.name}".`;
        messages.push({ role: 'toolResult', callId: call.callId, content: result });
      }
    }
    append('\n\n[Reached the maximum number of follow-up query rounds.]');
    return { fallback };
  }
}

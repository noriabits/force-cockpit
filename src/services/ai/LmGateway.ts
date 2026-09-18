// The ONLY AI file that imports `vscode`. It maps our neutral chat types
// (types.ts) to/from the VS Code Language Model API so AiExecutor stays
// vscode-free and unit-testable. Constructed in the feature `index.ts`.
import * as vscode from 'vscode';
import { dedupeModels, pickModel } from './modelSelection';
import {
  type ChatEvent,
  type ChatMessage,
  type ChatModelInfo,
  type ChatRequest,
  type LmGateway,
  NoModelsAvailableError,
} from './types';

type AssistantPart = vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart;
type UserPart = vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart;

/**
 * Sent alongside every tool result, because Copilot's "Auto" model routes on the
 * text of the LAST user message and refuses the request outright when it finds
 * none — "Auto mode needs a prompt or a command to route a request". A tool
 * result message carries nothing but result parts, so without this the very
 * first round that calls a tool kills the whole run on Auto, no matter how
 * well-formed the question was. Attached to every round's results rather than
 * only the last, so the prefix a round sends stays byte-identical on the next
 * round and remains eligible for prompt caching. The wording mirrors VS Code's
 * own tool-calling sample, which builds the same two-part message.
 */
function toolResultNote(count: number): string {
  return count === 1
    ? 'Above is the result of the tool call. Continue from it.'
    : 'Above are the results of the tool calls. Continue from them.';
}

function toVscodeMessage(msg: ChatMessage): vscode.LanguageModelChatMessage {
  if (msg.role === 'user') {
    return vscode.LanguageModelChatMessage.User(msg.text);
  }
  if (msg.role === 'assistant') {
    const parts: AssistantPart[] = [];
    if (msg.text) parts.push(new vscode.LanguageModelTextPart(msg.text));
    for (const tc of msg.toolCalls ?? []) {
      parts.push(new vscode.LanguageModelToolCallPart(tc.callId, tc.name, tc.input));
    }
    if (parts.length === 0) parts.push(new vscode.LanguageModelTextPart(''));
    return vscode.LanguageModelChatMessage.Assistant(parts);
  }
  // toolResult is never mapped alone — see toVscodeMessages.
  throw new Error(`Unexpected message role: ${(msg as { role: string }).role}`);
}

/**
 * One User message per ROUND of tool results, never one per result. When the
 * model calls several tools in a single assistant turn, the provider behind
 * Copilot (Anthropic in particular) requires every matching result to sit in the
 * one message immediately after that turn, ahead of any other content — it pairs
 * only the leading run of result parts and rejects the request outright
 * otherwise ("`tool_use` ids were found without `tool_result` blocks immediately
 * after"). So consecutive toolResult turns are folded into a single message
 * whose result parts all come first, with the Auto-routing note once at the end.
 */
function toVscodeMessages(messages: ChatMessage[]): vscode.LanguageModelChatMessage[] {
  const out: vscode.LanguageModelChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'toolResult') {
      out.push(toVscodeMessage(msg));
      continue;
    }
    const parts: UserPart[] = [];
    while (i < messages.length) {
      const next = messages[i];
      if (next.role !== 'toolResult') break;
      parts.push(
        new vscode.LanguageModelToolResultPart(next.callId, [
          new vscode.LanguageModelTextPart(next.content),
        ]),
      );
      i++;
    }
    i--; // the for-loop's own i++ consumes the non-toolResult we stopped on
    parts.push(new vscode.LanguageModelTextPart(toolResultNote(parts.length)));
    out.push(vscode.LanguageModelChatMessage.User(parts));
  }
  return out;
}

export class VsCodeLmGateway implements LmGateway {
  /**
   * The model list both entry points below resolve against. selectChatModels()
   * can return the same id from more than one vendor (Copilot registers both
   * `copilot` and the hidden `copilotcli`), so the list is de-duplicated here —
   * once — and never re-derived per call site. That is what stops a saved model
   * id from resolving to a different entry at send time than the one the picker
   * offered. See modelSelection.ts.
   */
  private async _selectModels(): Promise<vscode.LanguageModelChat[]> {
    return dedupeModels(await vscode.lm.selectChatModels());
  }

  async listModels(): Promise<ChatModelInfo[]> {
    const models = await this._selectModels();
    return models.map((m) => ({
      id: m.id,
      vendor: m.vendor,
      family: m.family,
      name: m.name,
      maxInputTokens: m.maxInputTokens,
    }));
  }

  async *send(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatEvent> {
    const models = await this._selectModels();
    const requested = req.modelId;
    const { model, fellBack } = pickModel(models, requested);
    if (!model) throw new NoModelsAvailableError();
    if (requested && fellBack) {
      yield { kind: 'modelFallback', requestedId: requested, usedModelName: model.name };
    }

    const messages = toVscodeMessages(req.messages);
    const tools: vscode.LanguageModelChatTool[] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));

    const cts = new vscode.CancellationTokenSource();
    const onAbort = () => cts.cancel();
    if (signal) {
      if (signal.aborted) cts.cancel();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const options: vscode.LanguageModelChatRequestOptions = tools.length ? { tools } : {};
      const response = await model.sendRequest(messages, options, cts.token);
      for await (const part of response.stream) {
        if (part instanceof vscode.LanguageModelTextPart) {
          yield { kind: 'text', text: part.value };
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          yield {
            kind: 'toolCall',
            call: {
              callId: part.callId,
              name: part.name,
              input: (part.input ?? {}) as Record<string, unknown>,
            },
          };
        }
      }
    } catch (err) {
      if (err instanceof vscode.LanguageModelError) {
        throw new Error(`Language model error: ${err.message}`);
      }
      throw err;
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
      cts.dispose();
    }
  }
}

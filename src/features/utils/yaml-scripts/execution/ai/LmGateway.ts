// The ONLY AI file that imports `vscode`. It maps our neutral chat types
// (types.ts) to/from the VS Code Language Model API so AiExecutor stays
// vscode-free and unit-testable. Constructed in the feature `index.ts`.
import * as vscode from 'vscode';
import {
  type ChatEvent,
  type ChatMessage,
  type ChatModelInfo,
  type ChatRequest,
  type LmGateway,
  NoModelsAvailableError,
} from './types';

type AssistantPart = vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart;

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
  // toolResult → a User message carrying the tool result part.
  return vscode.LanguageModelChatMessage.User([
    new vscode.LanguageModelToolResultPart(msg.callId, [
      new vscode.LanguageModelTextPart(msg.content),
    ]),
  ]);
}

export class VsCodeLmGateway implements LmGateway {
  async listModels(): Promise<ChatModelInfo[]> {
    const models = await vscode.lm.selectChatModels();
    return models.map((m) => ({
      id: m.id,
      vendor: m.vendor,
      family: m.family,
      name: m.name,
      maxInputTokens: m.maxInputTokens,
    }));
  }

  async *send(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatEvent> {
    const models = await vscode.lm.selectChatModels();
    if (models.length === 0) throw new NoModelsAvailableError();
    const model = req.modelId ? (models.find((m) => m.id === req.modelId) ?? models[0]) : models[0];

    const messages = req.messages.map(toVscodeMessage);
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

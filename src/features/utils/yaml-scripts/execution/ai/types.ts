// Neutral, vscode-free types for the AI executor. The concrete `LmGateway`
// implementation (LmGateway.ts) maps these to/from the VS Code Language Model
// API so AiExecutor stays unit-testable with a fake gateway.

export interface ChatModelInfo {
  id: string;
  vendor: string;
  family: string;
  name: string;
  maxInputTokens: number;
}

/** A tool the model may request. `inputSchema` is a JSON Schema object. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** A tool call the model proposed (our code decides whether/how to run it). */
export interface ToolCall {
  callId: string;
  name: string;
  input: Record<string, unknown>;
}

/** One turn of the conversation we send to the model. */
export type ChatMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls?: ToolCall[] }
  | { role: 'toolResult'; callId: string; content: string };

/** A fragment streamed back from the model. */
export type ChatEvent = { kind: 'text'; text: string } | { kind: 'toolCall'; call: ToolCall };

export interface ChatRequest {
  /** Preferred model id; gateway falls back to the first available model. */
  modelId?: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
}

/** Raised by the gateway when no language model is available (e.g. Copilot off). */
export class NoModelsAvailableError extends Error {
  constructor() {
    super('No language models available. Enable GitHub Copilot in VS Code and try again.');
    this.name = 'NoModelsAvailableError';
  }
}

export interface LmGateway {
  listModels(): Promise<ChatModelInfo[]>;
  send(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatEvent>;
}

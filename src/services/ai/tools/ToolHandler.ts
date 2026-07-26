import type { ToolSpec } from '../types';

/**
 * A tool the model may propose plus the code that actually runs it. The model
 * never executes anything itself — `AiConversation` looks the proposed call up
 * by `spec.name` and invokes `run` on its behalf.
 *
 * `append` writes a short progress line into the run transcript (the same
 * stream the user sees), so every tool call is visible as it happens.
 */
export interface ToolHandler {
  spec: ToolSpec;
  run(input: Record<string, unknown>, append: (s: string) => void): Promise<string> | string;
}

/** Read a string argument from a model-supplied tool input, trimmed. */
export function stringArg(input: Record<string, unknown>, name: string): string {
  const value = input[name];
  return typeof value === 'string' ? value.trim() : String(value ?? '').trim();
}

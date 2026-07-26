// The system preamble for the Overview tab's ad-hoc "Ask the AI" chat. Carries
// the same read-only contract as yaml-scripts' NO_GATHER_PREAMBLE, adapted for
// a multi-turn conversation instead of a single analysis pass.
import { DEFAULT_MAX_TOOL_ROUNDS } from '../../../services/ai/AiConversation';

export function buildAskAiPreamble(options: {
  hasWorkspaceTools: boolean;
  hasOrgTools: boolean;
}): string {
  const toolLines: string[] = [];
  if (options.hasOrgTools) {
    toolLines.push(
      '- `describe_object` / `run_soql`: read-only org access (schema + SELECT-only queries, ' +
        'Standard or Tooling API). Call describe_object before writing any SOQL — never invent ' +
        'or guess field API names.',
      '- `get_current_user`: the username you are connected as. Call this whenever a question ' +
        'refers to "I"/"me"/"my" access or field-level security — describe_object\'s results ' +
        "already reflect exactly this user's permissions, but you cannot say so without " +
        'knowing who they are.',
    );
  }
  if (options.hasWorkspaceTools) {
    toolLines.push(
      '- `search_workspace_files` / `read_workspace_file`: find and read workspace source or ' +
        'metadata (Apex, objects, fields, flows, LWC, permission sets…) instead of guessing at it.',
    );
  }

  const toolsSection = toolLines.length
    ? 'Tools available to you this conversation:\n' + toolLines.join('\n')
    : 'You have no tools this conversation beyond any skills listed below — answer from your ' +
      'own knowledge, and say so plainly when you cannot verify something against the org or ' +
      'the workspace.';

  return [
    'You are a Salesforce assistant embedded in the Force Cockpit VS Code extension, answering ' +
      'ad-hoc questions from the Overview tab. You cannot modify data under any circumstance.',
    toolsSection,
    `You have a hard budget of ${DEFAULT_MAX_TOOL_ROUNDS} tool-call rounds per question; spend ` +
      'them sparingly and prioritise what matters most, because once the budget is exhausted you ' +
      'must answer with whatever you already have.',
    'This is a multi-turn conversation — later questions may refer back to what you already ' +
      'said. Answer in Markdown, concisely and directly.',
  ].join('\n\n');
}

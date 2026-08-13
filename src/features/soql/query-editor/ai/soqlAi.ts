// Wires the SOQL query generator together: a shared ChatSession for the thread,
// the fixed tool set, and the bookkeeping that turns the model's final answer
// into a proposal the panel can run. Deliberately a factory over ChatSession
// rather than a service class of its own — there is no conversation state here
// that ChatSession does not already own.
import type { ConnectionManager } from '../../../../salesforce/connection';
import type { DescribeService } from '../../../../services/describe/DescribeService';
import type { ModelFallback } from '../../../../services/ai/AiConversation';
import { ChatSession } from '../../../../services/ai/ChatSession';
import {
  createCurrentUserTool,
  createDescribeObjectTool,
  createRunSoqlTool,
} from '../../../../services/ai/tools/orgTools';
import type { LmGateway } from '../../../../services/ai/types';
import type { QueryService } from '../QueryService';
import type { SoqlDiagnosticsService } from '../SoqlDiagnosticsService';
import { parseProposal, type SoqlProposal } from './parseProposal';
import { buildSoqlPreamble } from './prompt';
import { buildRequestMessage, type LastRun } from './requestMessage';
import { createValidateSoqlTool } from './validateSoqlTool';

export interface SoqlAiRequest {
  question: string;
  modelId?: string;
  /** Whatever is in the active tab's editor right now — the request is often about it. */
  currentQuery?: string;
  currentUseToolingApi?: boolean;
  /** The active tab's last result or error, so questions can be about the data itself. */
  lastRun?: LastRun | null;
}

export interface SoqlAiResult {
  answer: string;
  turnIndex: number;
  /** null when the model asked a clarifying question instead of proposing. */
  proposal: SoqlProposal | null;
  cancelled?: boolean;
  modelFallback?: ModelFallback;
}

export interface SoqlAiDeps {
  gateway: LmGateway;
  connectionManager: ConnectionManager;
  describeService: DescribeService;
  queryService: QueryService;
  diagnostics: SoqlDiagnosticsService;
}

export function createSoqlAi(deps: SoqlAiDeps) {
  const session = new ChatSession(deps.gateway);
  /**
   * Which API the last successful probe of THIS turn ran against, or undefined
   * if nothing was validated. Reset per turn — an API carried over from an
   * earlier question says nothing about the query being proposed now.
   */
  let lastValidatedToolingApi: boolean | undefined;
  /** Set per call so the tool can reach the route's AbortSignal. */
  let currentSignal: AbortSignal | undefined;

  const tools = [
    createDescribeObjectTool(deps.describeService),
    createRunSoqlTool(deps.connectionManager),
    createCurrentUserTool(deps.connectionManager),
    createValidateSoqlTool({
      queryService: deps.queryService,
      diagnostics: deps.diagnostics,
      getSignal: () => currentSignal,
      onValidated: (_soql, useToolingApi) => (lastValidatedToolingApi = useToolingApi),
    }),
  ];

  return {
    reset(): void {
      session.reset();
      lastValidatedToolingApi = undefined;
    },

    async generate(
      req: SoqlAiRequest,
      signal?: AbortSignal,
      onChunk?: (chunk: string) => void,
      onModelFallback?: (fallback: ModelFallback) => void,
    ): Promise<SoqlAiResult> {
      currentSignal = signal;
      lastValidatedToolingApi = undefined;
      try {
        const result = await session.ask(
          {
            question: buildRequestMessage(req),
            modelId: req.modelId,
            tools,
            firstMessagePrefix: `${buildSoqlPreamble()}\n\n`,
          },
          signal,
          onChunk,
          onModelFallback,
        );

        return { ...result, proposal: stamp(parseProposal(result.answer)) };
      } finally {
        currentSignal = undefined;
      }
    },
  };

  /**
   * Prefer the API the last successful probe ran against over the model's own
   * `soql-meta` block, which it regularly forgets to write after validating
   * against the Tooling API — proposing a metadata query that then fails on the
   * Standard API.
   *
   * "The last probe of this turn" rather than "the probe matching this query":
   * an earlier version keyed a map on normalised query text, which meant
   * chasing every way a proposal can differ from what was probed (the LIMIT,
   * whitespace, case…) for no gain. The model proposes what it just validated,
   * and a repair loop that retries on Tooling after the Standard API rejected
   * the object leaves the right answer last. Nothing validated this turn falls
   * back to the meta block, exactly as before.
   */
  function stamp(proposal: SoqlProposal | null): SoqlProposal | null {
    if (!proposal) return null;
    return lastValidatedToolingApi === undefined
      ? proposal
      : { ...proposal, useToolingApi: lastValidatedToolingApi };
  }
}

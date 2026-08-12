export type ScriptType = 'apex' | 'command' | 'js' | 'ai';

export interface ScriptInput {
  name: string;
  label?: string;
  type?: 'string' | 'picklist' | 'checkbox' | 'textarea';
  required?: boolean;
  options?: string[];
  default?: boolean;
}

/**
 * The fixed, author-defined data-gathering step of an `ai` script. Run by our
 * code (never by the model) before the prompt is sent for analysis.
 * `value` always holds the runnable code/SOQL (for `apex-file` it is the
 * resolved file content — mirroring how `scriptFile` + `script` coexist for
 * apex-file scripts); `file` keeps the workspace-relative path for round-trip.
 */
export interface GatherSpec {
  kind: 'apex' | 'apex-file' | 'soql';
  value: string;
  file?: string;
}

/**
 * One follow-up script run after this script's own body succeeds. `with` values
 * may reference `${...}` placeholders resolved against the running script's
 * inputs, its `outputs` (see `execution/scriptOutputs.ts`), and `${orgUsername}`
 * — so an apex script can hand a record it just created to the next script.
 */
export interface ScriptThenStep {
  /** Id of the script to run, e.g. `testData/create-enterprise-cart`. */
  script: string;
  /** Input values for the callee, before placeholder resolution. */
  with?: Record<string, string>;
  /**
   * Optional guard — the step is skipped unless it holds. Supports `==`, `!=`
   * and a bare truthiness test; see `execution/thenCondition.ts`.
   */
  when?: string;
}

export interface YamlScript {
  id: string;
  folder: string;
  name: string;
  description: string;
  type: ScriptType;
  /** For `ai` scripts this holds the analysis prompt; otherwise the code/command. */
  script: string;
  scriptFile?: string;
  source: 'builtin' | 'user' | 'private';
  inputs?: ScriptInput[];
  /** Scripts run in order after this one's body succeeds. */
  then?: ScriptThenStep[];
  filterUserDebug?: boolean;
  formatJson?: boolean;
  // ── ai-only ──
  /**
   * Chosen language-model id (from the picker). Required for new scripts; may be
   * absent on older saved scripts, in which case the gateway falls back to the
   * first available model.
   */
  model?: string;
  /** Fixed data-gathering step run before the analysis prompt. */
  gather?: GatherSpec;
  /** When true, the model may call the `run_soql` follow-up tool. */
  allowFollowupQueries?: boolean;
  /**
   * When true, the model may call the `search_workspace_files` and
   * `read_workspace_file` tools to discover and read workspace source/metadata
   * files (anything not excluded by `.gitignore`).
   */
  allowReadWorkspaceFiles?: boolean;
  /** Skill ids the model may pull in via the `read_skill` tool. */
  skills?: string[];
  invalid?: true;
  error?: string;
}

export interface ExecuteScriptResult {
  scriptId: string;
  success: boolean;
  message: string;
  debugLog: string;
  filteredDebugLog?: string;
  cancelled?: boolean;
  /**
   * Values the script handed back to its caller, for script composition. Filled
   * from `::fc-output name=value` marker lines in the log (apex/command/ai) or
   * from `setOutput()` calls (js). See `execution/scriptOutputs.ts`.
   */
  outputs?: Record<string, string>;
  /**
   * Set for `ai` scripts when the saved model was unavailable and the gateway
   * fell back to another model. Lets the caller surface a warning to the user.
   */
  modelFallback?: { requestedId: string; usedModelName: string };
}

export interface RunScriptOptions {
  /**
   * When false, a failed child resolves with its result instead of rejecting.
   * Defaults to true — a silently ignored failure inside an `await` chain is a
   * footgun.
   */
  throwOnError?: boolean;
}

/**
 * The `runScript` global exposed to `js` scripts: runs another script by id and
 * resolves with its result (including any `outputs` it produced).
 */
export type RunScriptFn = (
  id: string,
  inputs?: Record<string, string>,
  options?: RunScriptOptions,
) => Promise<ExecuteScriptResult>;

/**
 * Builds a `runScript` bound to one running script. `emit` writes into that
 * script's own output, so a child's log ends up in the parent's `debugLog` and
 * not only in the live stream.
 */
export type MakeRunScript = (emit: (text: string) => void) => RunScriptFn;

export interface SaveScriptInput {
  name: string;
  description: string;
  type: ScriptType;
  folder: string;
  script: string;
  scriptFile?: string;
  inputs?: ScriptInput[];
  /** Scripts run in order after this one's body succeeds. */
  then?: ScriptThenStep[];
  filterUserDebug?: boolean;
  formatJson?: boolean;
  // ── ai-only ──
  model?: string;
  gather?: GatherSpec;
  allowFollowupQueries?: boolean;
  allowReadWorkspaceFiles?: boolean;
  skills?: string[];
}

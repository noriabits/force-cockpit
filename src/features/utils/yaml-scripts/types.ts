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
}

export interface SaveScriptInput {
  name: string;
  description: string;
  type: ScriptType;
  folder: string;
  script: string;
  scriptFile?: string;
  inputs?: ScriptInput[];
  filterUserDebug?: boolean;
  formatJson?: boolean;
  // ── ai-only ──
  model?: string;
  gather?: GatherSpec;
  allowFollowupQueries?: boolean;
  allowReadWorkspaceFiles?: boolean;
  skills?: string[];
}

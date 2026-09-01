import type { YamlSource } from '../../../../utils/yaml-loader';
import type {
  GatherSpec,
  RestSpec,
  ScriptInput,
  ScriptThenStep,
  ScriptType,
  YamlScript,
} from '../types';

/**
 * Assembly of the finished `YamlScript` record, split out of `ScriptParser.parse`
 * so that method is the guard chain and nothing else. Two thirds of `parse`'s
 * complexity was this one object literal: twelve conditional spreads deciding
 * which optional fields a script of this type actually carries.
 *
 * The webview has the mirror of this on its save path —
 * `view/script-form-payload.ts`'s `buildScriptPayload` — down to bundling the
 * per-type fields into one optional group each and spreading them wholesale.
 *
 * Every optional field is OMITTED rather than set to a falsy value: a `YamlScript`
 * round-trips through `postMessage` and back into the form, and an explicit
 * `skills: []` or `model: ''` is not the same document as one that never named
 * them.
 */

/** The raw `apex:`-only flags, still exactly as YAML handed them over. */
type ApexRawFields = {
  filterUserDebug?: unknown;
  formatJson?: unknown;
};

/**
 * The `ai:`-only fields. `gather` and `skills` are already resolved by the
 * caller (they can fail validation, which is the parser's business, not this
 * module's); the flags are raw and tested for truthiness, as they always were.
 */
type AiRawFields = {
  model?: unknown;
  gather?: GatherSpec;
  allowFollowupQueries?: unknown;
  allowReadWorkspaceFiles?: unknown;
  skills: string[];
};

function apexFields(type: ScriptType, apex: ApexRawFields | undefined) {
  if (type !== 'apex' || !apex) return {};
  return {
    ...(apex.filterUserDebug ? { filterUserDebug: true } : {}),
    ...(apex.formatJson ? { formatJson: true } : {}),
  };
}

function aiFields(type: ScriptType, ai: AiRawFields | undefined) {
  if (type !== 'ai' || !ai) return {};
  const model = typeof ai.model === 'string' ? ai.model.trim() : '';
  return {
    ...(model ? { model } : {}),
    ...(ai.gather ? { gather: ai.gather } : {}),
    ...(ai.allowFollowupQueries ? { allowFollowupQueries: true } : {}),
    ...(ai.allowReadWorkspaceFiles ? { allowReadWorkspaceFiles: true } : {}),
    ...(ai.skills.length ? { skills: ai.skills } : {}),
  };
}

export function buildYamlScript(opts: {
  id: string;
  folder: string;
  name: string;
  description?: string;
  type: ScriptType;
  source: YamlSource;
  script: string;
  scriptFile?: string;
  inputs: ScriptInput[];
  then: ScriptThenStep[];
  apex?: ApexRawFields;
  ai?: AiRawFields;
  rest?: RestSpec;
}): YamlScript {
  return {
    id: opts.id,
    folder: opts.folder,
    name: opts.name,
    description: opts.description ?? '',
    type: opts.type,
    script: opts.script,
    ...(opts.scriptFile ? { scriptFile: opts.scriptFile } : {}),
    source: opts.source,
    ...(opts.inputs.length ? { inputs: opts.inputs } : {}),
    ...(opts.then.length ? { then: opts.then } : {}),
    ...apexFields(opts.type, opts.apex),
    ...aiFields(opts.type, opts.ai),
    ...(opts.rest ? { rest: opts.rest } : {}),
  };
}

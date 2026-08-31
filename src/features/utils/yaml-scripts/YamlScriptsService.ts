import type { ConnectionManager } from '../../../salesforce/connection';
import type { DescribeService } from '../../../services/describe/DescribeService';
import { loadYamlItems } from '../../../utils/yaml-loader';
import { ScriptParser } from './parsing/ScriptParser';
import {
  buildInputVars,
  substituteInputs,
  substituteRestSpec,
  substituteSystemPlaceholders,
  substituteVars,
  validateRequiredInputs,
} from './parsing/PlaceholderResolver';
import { ApexExecutor } from './execution/ApexExecutor';
import { CommandExecutor } from './execution/CommandExecutor';
import { JsExecutor } from './execution/JsExecutor';
import { AiExecutor } from './execution/ai/AiExecutor';
import { RestExecutor } from './execution/RestExecutor';
import { RestCallService } from '../../../services/rest/RestCallService';
import type { LmGateway, WorkspaceSearch } from '../../../services/ai/types';
import { ScriptRepository } from './persistence/ScriptRepository';
import type { SkillsRepository } from '../../../services/skills/SkillsRepository';
import { extractOutputMarkers } from './execution/scriptOutputs';
import { buildThenVars, runThenChain } from './execution/thenSteps';
import type {
  ExecuteScriptResult,
  MakeRunScript,
  RunScriptFn,
  SaveScriptInput,
  YamlScript,
} from './types';

export type { ExecuteScriptResult, SaveScriptInput, YamlScript } from './types';

/** Guards against a runaway chain when scripts call each other legitimately. */
const MAX_CHAIN_DEPTH = 10;

interface ServicePaths {
  builtInPath: string;
  userPath: string;
  privatePath: string;
  workspaceRoot: string;
}

export class YamlScriptsService {
  private readonly parser: ScriptParser;
  private readonly repo: ScriptRepository;
  private readonly apex: ApexExecutor;
  private readonly command: CommandExecutor;
  private readonly js: JsExecutor;
  private readonly ai: AiExecutor;
  private readonly rest: RestExecutor;

  constructor(
    private readonly connectionManager: ConnectionManager,
    private readonly paths: ServicePaths,
    gateway: LmGateway,
    skills: SkillsRepository,
    describeService: DescribeService,
    workspaceSearch?: WorkspaceSearch,
  ) {
    this.parser = new ScriptParser(paths.workspaceRoot);
    this.repo = new ScriptRepository({
      userPath: paths.userPath,
      privatePath: paths.privatePath,
      workspaceRoot: paths.workspaceRoot,
    });
    // One REST service shared by the `rest` type and the `js` sandbox's
    // restCall() global — it is stateless, and both want identical header
    // merging, endpoint normalization and 401-replay behaviour.
    const restCallService = new RestCallService(connectionManager);
    this.apex = new ApexExecutor(connectionManager);
    this.command = new CommandExecutor(paths.workspaceRoot);
    this.js = new JsExecutor(connectionManager, paths.workspaceRoot, restCallService);
    this.ai = new AiExecutor(connectionManager, gateway, skills, describeService, workspaceSearch);
    this.rest = new RestExecutor(restCallService);
  }

  async loadScripts(): Promise<YamlScript[]> {
    return loadYamlItems(this.paths, (filePath, id, folder, source) =>
      this.parser.parse(filePath, id, folder, source),
    );
  }

  async executeScript(
    scriptId: string,
    scripts: YamlScript[],
    inputValues?: Record<string, string>,
    signal?: AbortSignal,
    onLogChunk?: (chunk: string) => void,
    onModelFallback?: (fallback: { requestedId: string; usedModelName: string }) => void,
  ): Promise<ExecuteScriptResult> {
    return this.executeInternal(
      scriptId,
      scripts,
      inputValues,
      signal,
      onLogChunk,
      onModelFallback,
      [scriptId],
    );
  }

  /**
   * @param callStack ids of the scripts currently running, outermost first. Its
   *        length is the chain depth and its contents detect cycles; only the
   *        outermost call writes an execution log.
   */
  private async executeInternal(
    scriptId: string,
    scripts: YamlScript[],
    inputValues: Record<string, string> | undefined,
    signal: AbortSignal | undefined,
    onLogChunk: ((chunk: string) => void) | undefined,
    onModelFallback:
      | ((fallback: { requestedId: string; usedModelName: string }) => void)
      | undefined,
    callStack: string[],
  ): Promise<ExecuteScriptResult> {
    const script = scripts.find((s) => s.id === scriptId);
    if (!script) {
      return { scriptId, success: false, message: `Script not found: ${scriptId}`, debugLog: '' };
    }

    const inputError = validateRequiredInputs(script, inputValues);
    if (inputError) {
      return { scriptId, success: false, message: inputError, debugLog: '' };
    }

    const finalScript = this.resolvePlaceholders(script, inputValues);
    const makeRunScript = this.makeRunScriptFactory(scripts, signal, onModelFallback, callStack);
    const result = await this.dispatchExecution(
      finalScript,
      signal,
      onLogChunk,
      onModelFallback,
      makeRunScript,
    );

    // Each kind has exactly one output mechanism. A `js` script's log also
    // carries the logs of everything it called, so scraping markers out of it
    // would silently adopt its children's outputs as its own — it uses
    // setOutput() exclusively and re-exports a child's value deliberately.
    // A `rest` script builds its outputs from the response itself (status plus
    // the body's top-level scalars); scanning its log for markers would let a
    // response body that happens to contain the marker text define outputs.
    const publishesDirectly = script.type === 'js' || script.type === 'rest';
    const outputs = publishesDirectly
      ? (result.outputs ?? {})
      : extractOutputMarkers(result.filteredDebugLog ?? result.debugLog);

    const chained = await this.runThenSteps(
      script,
      { ...result, outputs },
      inputValues,
      scripts,
      signal,
      onLogChunk,
      onModelFallback,
      callStack,
    );

    // Only the outermost call writes a log file — otherwise a chain leaves one
    // file per link behind.
    if (callStack.length === 1) {
      this.repo.saveExecutionLog(script.name, chained.debugLog);
    }
    return chained;
  }

  /**
   * Runs the script's `then:` steps, in order, once its own body has succeeded.
   * Reuses the `runScript` machinery so cycle/depth guards, the child header and
   * fail-fast behaviour are identical to a `js` script calling out. The guard
   * evaluation, `with:` resolution and step loop itself live in
   * `execution/thenSteps.ts`; this method only wires up this run's `vars`/`emit`
   * and folds the chain's own log into the parent's result.
   */
  private async runThenSteps(
    script: YamlScript,
    result: ExecuteScriptResult,
    inputValues: Record<string, string> | undefined,
    scripts: YamlScript[],
    signal: AbortSignal | undefined,
    onLogChunk: ((chunk: string) => void) | undefined,
    onModelFallback:
      | ((fallback: { requestedId: string; usedModelName: string }) => void)
      | undefined,
    callStack: string[],
  ): Promise<ExecuteScriptResult> {
    if (!script.then?.length || !result.success || result.cancelled) return result;

    const vars = buildThenVars(
      this.connectionManager.getCurrentOrg()?.username ?? '',
      inputValues,
      result.outputs,
    );

    let chainLog = '';
    const emit = (text: string) => {
      chainLog += text;
      onLogChunk?.(text);
    };
    const runStep = this.makeRunScriptFactory(scripts, signal, onModelFallback, callStack)(emit);

    const outcome = await runThenChain(script.then, vars, runStep, emit);

    return {
      ...result,
      debugLog: result.debugLog + chainLog,
      ...(result.filteredDebugLog !== undefined
        ? { filteredDebugLog: result.filteredDebugLog + chainLog }
        : {}),
      ...outcome,
    };
  }

  /**
   * Builds the `runScript` global handed to a `js` script. `emit` writes into
   * the calling script's own output so a child's log survives into the parent's
   * `debugLog`, not just the live stream.
   */
  private makeRunScriptFactory(
    scripts: YamlScript[],
    signal: AbortSignal | undefined,
    onModelFallback:
      | ((fallback: { requestedId: string; usedModelName: string }) => void)
      | undefined,
    callStack: string[],
  ): MakeRunScript {
    return (emit): RunScriptFn =>
      async (childId, childInputs, options) => {
        if (callStack.includes(childId)) {
          throw new Error(`Circular script call: ${[...callStack, childId].join(' → ')}`);
        }
        if (callStack.length >= MAX_CHAIN_DEPTH) {
          throw new Error(
            `Script call depth limit (${MAX_CHAIN_DEPTH}) exceeded: ${callStack.join(' → ')}`,
          );
        }

        emit(`\n── ▶ ${childId} ──\n`);
        const result = await this.executeInternal(
          childId,
          scripts,
          childInputs ?? {},
          signal,
          emit,
          onModelFallback,
          [...callStack, childId],
        );

        // Apex never streams, so its log only exists once the run is over.
        const child = scripts.find((s) => s.id === childId);
        if (child?.type === 'apex') {
          const log = result.filteredDebugLog?.trim() ? result.filteredDebugLog : result.debugLog;
          if (log) emit(log.endsWith('\n') ? log : log + '\n');
        }

        if (!result.success && options?.throwOnError !== false) {
          // Preserve the cancellation sentinel rather than wrapping it — callers
          // (runThenSteps, JsExecutor's abort race) match on this exact message
          // to tell a deliberate cancel from a genuine failure.
          if (result.cancelled) throw new Error('Operation cancelled');
          throw new Error(`Script "${childId}" failed: ${result.message}`);
        }
        return result;
      };
  }

  saveScript(input: SaveScriptInput, isPrivate = false): YamlScript {
    return this.repo.save(input, isPrivate);
  }

  updateScript(
    oldScriptId: string,
    input: SaveScriptInput,
    isPrivate = false,
    wasPrivate = false,
  ): YamlScript {
    return this.repo.update(oldScriptId, input, isPrivate, wasPrivate);
  }

  deleteScript(scriptId: string, isPrivate = false): void {
    this.repo.delete(scriptId, isPrivate);
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private resolvePlaceholders(script: YamlScript, values?: Record<string, string>): YamlScript {
    const org = this.connectionManager.getCurrentOrg();
    const orgUsername = org?.username ?? '';
    const withInputs = substituteInputs(script, values);
    const finalCode = substituteSystemPlaceholders(withInputs, script.type, { orgUsername });

    // User inputs win over system vars, matching the prompt/code substitution order.
    const vars = { orgUsername, ...buildInputVars(script.inputs, values) };

    // ai gather step: Apex-style escaping, quote-safe for both inline Apex and
    // SOQL WHERE clauses.
    const gather = script.gather
      ? { ...script.gather, value: substituteVars(script.gather.value, vars, 'apex') }
      : undefined;

    const rest = script.rest ? substituteRestSpec(script.rest, vars) : undefined;

    return {
      ...script,
      script: finalCode,
      ...(gather ? { gather } : {}),
      ...(rest ? { rest } : {}),
    };
  }

  private dispatchExecution(
    script: YamlScript,
    signal?: AbortSignal,
    onLogChunk?: (chunk: string) => void,
    onModelFallback?: (fallback: { requestedId: string; usedModelName: string }) => void,
    makeRunScript?: MakeRunScript,
  ): Promise<ExecuteScriptResult> {
    switch (script.type) {
      case 'command':
        return this.command.execute(script, signal, onLogChunk);
      case 'js':
        return this.js.execute(script, signal, onLogChunk, makeRunScript);
      case 'apex':
        return this.apex.execute(script);
      case 'ai':
        return this.ai.execute(script, signal, onLogChunk, onModelFallback);
      case 'rest':
        return this.rest.execute(script, signal, onLogChunk);
    }
  }
}

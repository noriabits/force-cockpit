import type { ConnectionManager } from '../../../salesforce/connection';
import type { DescribeService } from '../../../services/describe/DescribeService';
import { loadYamlItems } from '../../../utils/yaml-loader';
import { ScriptParser } from './parsing/ScriptParser';
import {
  clearUnresolvedVars,
  substituteInputs,
  substituteSystemPlaceholders,
  substituteVars,
  validateRequiredInputs,
} from './parsing/PlaceholderResolver';
import { ApexExecutor } from './execution/ApexExecutor';
import { CommandExecutor } from './execution/CommandExecutor';
import { JsExecutor } from './execution/JsExecutor';
import { AiExecutor } from './execution/ai/AiExecutor';
import type { LmGateway, WorkspaceSearch } from '../../../services/ai/types';
import { ScriptRepository } from './persistence/ScriptRepository';
import type { SkillsRepository } from '../../../services/skills/SkillsRepository';
import { extractOutputMarkers } from './execution/scriptOutputs';
import { evaluateWhen, resolveWhenExpression } from './execution/thenCondition';
import type {
  ExecuteScriptResult,
  MakeRunScript,
  RunScriptFn,
  SaveScriptInput,
  YamlScript,
} from './types';

export type { ExecuteScriptResult, SaveScriptInput, ScriptInput, YamlScript } from './types';

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
    this.apex = new ApexExecutor(connectionManager);
    this.command = new CommandExecutor(paths.workspaceRoot);
    this.js = new JsExecutor(connectionManager, paths.workspaceRoot);
    this.ai = new AiExecutor(connectionManager, gateway, skills, describeService, workspaceSearch);
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
    const outputs =
      script.type === 'js'
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
   * fail-fast behaviour are identical to a `js` script calling out.
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

    // `then` values are data handed to the callee, which escapes them for its
    // own type — so they are substituted raw here. Outputs override inputs: the
    // point of `then` is to forward what this run just produced.
    const vars: Record<string, string> = {
      orgUsername: this.connectionManager.getCurrentOrg()?.username ?? '',
      ...(inputValues ?? {}),
      ...(result.outputs ?? {}),
    };

    let chainLog = '';
    const emit = (text: string) => {
      chainLog += text;
      onLogChunk?.(text);
    };
    const runStep = this.makeRunScriptFactory(scripts, signal, onModelFallback, callStack)(emit);

    const withChainLog = (over: Partial<ExecuteScriptResult>): ExecuteScriptResult => ({
      ...result,
      debugLog: result.debugLog + chainLog,
      ...(result.filteredDebugLog !== undefined
        ? { filteredDebugLog: result.filteredDebugLog + chainLog }
        : {}),
      ...over,
    });

    for (const step of script.then) {
      try {
        const passed = evaluateWhen(step.when, vars);

        // Both outcomes are announced, with the substituted expression next to
        // the original: a guard that fires the wrong way then shows its own
        // reason, instead of the step silently appearing or vanishing.
        if (step.when) {
          const detail = `when: ${step.when} → ${resolveWhenExpression(step.when, vars)}`;
          // No trailing newline on the passing line — the step header that
          // follows opens with one.
          emit(
            passed
              ? `\n── ✔ ${step.script} (${detail}) ──`
              : `\n── ⏭ ${step.script} skipped (${detail}) ──\n`,
          );
        }
        if (!passed) continue;

        const values = Object.fromEntries(
          Object.entries(step.with ?? {}).map(([key, value]) => [
            key,
            // Raw ('command' applies no escaping) — these are data, and the
            // callee escapes them for its own type. A name the previous script
            // never published resolves to empty, so the callee's `required:`
            // check reports it instead of the literal `${name}` reaching an org.
            clearUnresolvedVars(substituteVars(value, vars, 'command')),
          ]),
        );

        await runStep(step.script, values);
      } catch (err) {
        const message = (err as Error).message;
        if (message === 'Operation cancelled') {
          return withChainLog({ cancelled: true, success: false, message: '' });
        }
        emit(`\n--- error ---\n${message}\n`);
        return withChainLog({ success: false, message });
      }
    }
    return withChainLog({});
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

    // ai gather step: substitute into the gather code with Apex-style escaping
    // (quote-safe for both inline Apex and SOQL WHERE clauses). User inputs win
    // over system vars, matching the prompt/code substitution order.
    let gather = script.gather;
    if (gather) {
      const inputVars = Object.fromEntries(
        (script.inputs ?? []).map((inp) => [inp.name, values?.[inp.name] ?? '']),
      );
      const value = substituteVars(gather.value, { orgUsername, ...inputVars }, 'apex');
      gather = { ...gather, value };
    }

    return { ...script, script: finalCode, ...(gather ? { gather } : {}) };
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
    }
  }
}

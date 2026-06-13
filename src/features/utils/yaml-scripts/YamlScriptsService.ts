import type { ConnectionManager } from '../../../salesforce/connection';
import type { DescribeService } from '../../../services/DescribeService';
import { loadYamlItems } from '../../../utils/yaml-loader';
import { ScriptParser } from './parsing/ScriptParser';
import {
  substituteInputs,
  substituteSystemPlaceholders,
  substituteVars,
  validateRequiredInputs,
} from './parsing/PlaceholderResolver';
import { ApexExecutor } from './execution/ApexExecutor';
import { CommandExecutor } from './execution/CommandExecutor';
import { JsExecutor } from './execution/JsExecutor';
import { AiExecutor } from './execution/ai/AiExecutor';
import type { LmGateway } from './execution/ai/types';
import { ScriptRepository } from './persistence/ScriptRepository';
import type { SkillsRepository } from './skills/SkillsRepository';
import type { ExecuteScriptResult, SaveScriptInput, YamlScript } from './types';

export type { ExecuteScriptResult, SaveScriptInput, ScriptInput, YamlScript } from './types';

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
    this.ai = new AiExecutor(connectionManager, gateway, skills, describeService);
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
    const result = await this.dispatchExecution(finalScript, signal, onLogChunk);

    this.repo.saveExecutionLog(script.name, result.debugLog);
    return result;
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
  ): Promise<ExecuteScriptResult> {
    switch (script.type) {
      case 'command':
        return this.command.execute(script, signal, onLogChunk);
      case 'js':
        return this.js.execute(script, signal, onLogChunk);
      case 'apex':
        return this.apex.execute(script);
      case 'ai':
        return this.ai.execute(script, signal, onLogChunk);
    }
  }
}

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { createContext, Script } from 'vm';
import type { ConnectionManager } from '../../../salesforce/connection';
import { assertApexSuccess, filterUserDebugLines } from '../../apexUtils';
import { runTerminalCommand } from '../../../utils/terminalCommand';
import { loadYamlItems, type YamlSource } from '../../../utils/yaml-loader';

type ParsedYamlDoc = {
  name?: string;
  description?: string;
  apex?: string;
  command?: string;
  js?: string;
  'apex-file'?: string;
  'command-file'?: string;
  'js-file'?: string;
  inputs?: unknown[];
  'filter-user-debug'?: boolean;
  'format-json'?: boolean;
};

export interface ScriptInput {
  name: string; // variable identifier used in ${name} placeholders
  label?: string; // display label (defaults to name)
  type?: 'string' | 'picklist' | 'checkbox' | 'textarea'; // default 'string'
  required?: boolean;
  options?: string[]; // required when type is 'picklist'
  default?: boolean; // initial checked state for checkbox type
}

export interface YamlScript {
  id: string; // "{folder}/{filename-without-ext}"
  folder: string;
  name: string;
  description: string;
  type: 'apex' | 'command' | 'js';
  script: string; // normalized from apex:, command:, or js: (or read from file for *-file variants)
  scriptFile?: string; // relative path (to workspaceRoot) when using apex-file/js-file/command-file
  source: 'builtin' | 'user' | 'private';
  inputs?: ScriptInput[];
  filterUserDebug?: boolean; // apex only: pre-check "Show only USER_DEBUG lines"
  formatJson?: boolean; // apex only: pre-check "Format JSON"
  invalid?: true; // present only when the file has a structural problem
  error?: string; // human-readable description of the problem
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
  type: 'apex' | 'command' | 'js';
  folder: string;
  script: string;
  scriptFile?: string; // when set, write apex-file/js-file/command-file instead of inline
  inputs?: ScriptInput[];
  filterUserDebug?: boolean; // apex only
  formatJson?: boolean; // apex only
}

export class YamlScriptsService {
  constructor(
    private readonly connectionManager: ConnectionManager,
    private readonly paths: {
      builtInPath: string;
      userPath: string;
      privatePath: string;
      workspaceRoot: string;
    },
  ) {}

  async loadScripts(): Promise<YamlScript[]> {
    return loadYamlItems(this.paths, (filePath, id, folder, source) =>
      this.parseScript(filePath, id, folder, source),
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

    // Validate required inputs
    if (script.inputs?.length) {
      for (const inp of script.inputs) {
        if (inp.required && !inputValues?.[inp.name]?.trim()) {
          return {
            scriptId,
            success: false,
            message: `Required input "${inp.label || inp.name}" is missing.`,
            debugLog: '',
          };
        }
      }
    }

    // Substitute input placeholders, then system placeholders
    const resolvedScript = this.substituteInputs(script, inputValues);
    const finalScript = this.substituteSystemPlaceholders(resolvedScript, script.type);

    let result: ExecuteScriptResult;

    if (script.type === 'command') {
      result = await this.executeTerminalCommand(
        { ...script, script: finalScript },
        signal,
        onLogChunk,
      );
    } else if (script.type === 'js') {
      result = await this.executeJs({ ...script, script: finalScript }, signal, onLogChunk);
    } else {
      try {
        const apexResult = await this.connectionManager.executeAnonymousWithDebugLog(finalScript, {
          logLevels: { Apex_code: 'DEBUG' },
        });
        assertApexSuccess(apexResult);
        const debugLog = apexResult.debugLog ?? '';
        result = {
          scriptId,
          success: true,
          message: `Script "${script.name}" executed successfully.`,
          debugLog,
          filteredDebugLog: filterUserDebugLines(debugLog),
        };
      } catch (err) {
        result = { scriptId, success: false, message: (err as Error).message, debugLog: '' };
      }
    }

    this.saveExecutionLog(script.name, result.debugLog);
    return result;
  }

  private substituteVars(
    code: string,
    vars: Record<string, string>,
    type: 'apex' | 'command' | 'js',
  ): string {
    let result = code;
    for (const [key, raw] of Object.entries(vars)) {
      const escaped = this.escapeForType(raw, type);
      const pattern = new RegExp(`\\$\\{${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}`, 'g');
      result = result.replace(pattern, escaped);
    }
    return result;
  }

  private substituteInputs(script: YamlScript, values?: Record<string, string>): string {
    if (!script.inputs?.length || !values) return script.script;
    const vars = Object.fromEntries(script.inputs.map((inp) => [inp.name, values[inp.name] ?? '']));
    return this.substituteVars(script.script, vars, script.type);
  }

  private substituteSystemPlaceholders(
    content: string,
    scriptType: 'apex' | 'command' | 'js',
  ): string {
    const org = this.connectionManager.getCurrentOrg();
    const systemVars: Record<string, string> = {
      orgUsername: org?.username ?? '',
    };
    return this.substituteVars(content, systemVars, scriptType);
  }

  private escapeForType(value: string, type: 'apex' | 'command' | 'js'): string {
    switch (type) {
      case 'apex':
        return value
          .replace(/\\/g, '\\\\')
          .replace(/'/g, "''")
          .replace(/\r\n/g, '\\n')
          .replace(/\n/g, '\\n')
          .replace(/\r/g, '\\n');
      case 'js':
        return JSON.stringify(value).slice(1, -1);
      case 'command':
        return value;
    }
  }

  private async executeJs(
    script: YamlScript,
    signal?: AbortSignal,
    onLogChunk?: (chunk: string) => void,
  ): Promise<ExecuteScriptResult> {
    const output: string[] = [];
    const logFn = (...args: unknown[]) => {
      const line = args.map(String).join(' ');
      output.push(line);
      onLogChunk?.(line + '\n');
    };
    const errorFn = (...args: unknown[]) => {
      const line = `[ERROR] ${args.map(String).join(' ')}`;
      output.push(line);
      onLogChunk?.(line + '\n');
    };

    try {
      const contextObj = {
        connection: this.connectionManager.getConnection(),
        org: this.connectionManager.getCurrentOrg(),
        query: (soql: string) => this.connectionManager.query(soql),
        log: logFn,
        error: errorFn,
        console: { log: logFn, error: errorFn, warn: logFn },
        fs,
        path,
        yaml,
        DOMParser,
        XMLSerializer,
        setTimeout,
        clearTimeout,
        Promise,
      };

      const vmContext = createContext(contextObj);
      const wrapped = `(async () => { ${script.script} })()`;
      const vmScript = new Script(wrapped);
      const execution = vmScript.runInContext(vmContext, { breakOnSigint: true }) as Promise<void>;

      if (signal) {
        const abortPromise = new Promise<never>((_, reject) =>
          signal.addEventListener('abort', () => reject(new Error('Operation cancelled')), {
            once: true,
          }),
        );
        await Promise.race([execution, abortPromise]);
      } else {
        await execution;
      }

      return {
        scriptId: script.id,
        success: true,
        message: `Script "${script.name}" executed successfully.`,
        debugLog: output.join('\n'),
      };
    } catch (err) {
      const errorMsg = (err as Error).message;
      if (errorMsg === 'Operation cancelled') {
        return { scriptId: script.id, success: false, message: '', debugLog: '', cancelled: true };
      }
      output.push(`\n--- error ---\n${errorMsg}`);
      return {
        scriptId: script.id,
        success: false,
        message: errorMsg,
        debugLog: output.join('\n'),
      };
    }
  }

  private async executeTerminalCommand(
    script: YamlScript,
    signal?: AbortSignal,
    onLogChunk?: (chunk: string) => void,
  ): Promise<ExecuteScriptResult> {
    const result = await runTerminalCommand(
      script.script,
      this.paths.workspaceRoot || undefined,
      signal,
      onLogChunk,
    );
    if (result.cancelled) {
      return { scriptId: script.id, success: false, message: '', debugLog: '', cancelled: true };
    }
    return {
      scriptId: script.id,
      success: result.success,
      message: result.success
        ? `Command "${script.name}" completed successfully.`
        : `Command failed`,
      debugLog: result.output,
    };
  }

  saveScript(input: SaveScriptInput, isPrivate = false): YamlScript {
    const basePath = isPrivate ? this.paths.privatePath : this.paths.userPath;
    if (!basePath || !path.isAbsolute(basePath)) {
      throw new Error('Cannot save: no workspace folder is open. Open a folder in VS Code first.');
    }

    if (input.scriptFile) {
      this.validateScriptFile(input.scriptFile);
    }

    const slug = this.toSlug(input.name);
    const folder = (input.folder || 'utils').trim();
    const id = `${folder}/${slug}`;

    // Block duplicate IDs across shared/private
    const otherPath = isPrivate ? this.paths.userPath : this.paths.privatePath;
    this.checkDuplicateId(id, otherPath);

    const targetDir = path.join(basePath, folder);
    const targetPath = path.join(targetDir, `${slug}.yaml`);
    fs.mkdirSync(targetDir, { recursive: true });

    const data = this.buildYamlData(input);
    fs.writeFileSync(targetPath, yaml.dump(data), 'utf8');

    return {
      id,
      folder,
      name: input.name,
      description: input.description ?? '',
      type: input.type,
      script: input.script,
      ...(input.scriptFile ? { scriptFile: input.scriptFile } : {}),
      source: isPrivate ? 'private' : 'user',
      ...(input.inputs?.length ? { inputs: input.inputs } : {}),
      ...(input.filterUserDebug ? { filterUserDebug: true } : {}),
      ...(input.formatJson ? { formatJson: true } : {}),
    };
  }

  private resolveUpdatePaths(
    oldScriptId: string,
    input: SaveScriptInput,
    isPrivate: boolean,
    wasPrivate: boolean,
  ): {
    basePath: string;
    oldBasePath: string;
    newSlug: string;
    newFolder: string;
    newId: string;
    newDir: string;
    newPath: string;
    oldPath: string;
  } {
    const basePath = isPrivate ? this.paths.privatePath : this.paths.userPath;
    if (!basePath || !path.isAbsolute(basePath)) {
      throw new Error('Cannot save: no workspace folder is open. Open a folder in VS Code first.');
    }
    const oldBasePath = wasPrivate ? this.paths.privatePath : this.paths.userPath;
    const newSlug = this.toSlug(input.name);
    const newFolder = (input.folder || 'utils').trim();
    const newId = `${newFolder}/${newSlug}`;
    const newDir = path.join(basePath, newFolder);
    const newPath = path.join(newDir, `${newSlug}.yaml`);
    const oldParts = oldScriptId.split('/');
    const oldPath = path.join(
      oldBasePath,
      oldParts.slice(0, -1).join('/'),
      `${oldParts[oldParts.length - 1]}.yaml`,
    );
    return { basePath, oldBasePath, newSlug, newFolder, newId, newDir, newPath, oldPath };
  }

  updateScript(
    oldScriptId: string,
    input: SaveScriptInput,
    isPrivate = false,
    wasPrivate = false,
  ): YamlScript {
    const { newFolder, newId, newDir, newPath, oldPath } = this.resolveUpdatePaths(
      oldScriptId,
      input,
      isPrivate,
      wasPrivate,
    );

    if (input.scriptFile) {
      this.validateScriptFile(input.scriptFile);
    }

    // Block duplicate IDs across shared/private.
    // Skip when the "conflict" in the other path is the old file being moved there.
    if (oldScriptId !== newId || isPrivate !== wasPrivate) {
      const otherPath = isPrivate ? this.paths.userPath : this.paths.privatePath;
      const movingSameId = isPrivate !== wasPrivate && oldScriptId === newId;
      if (!movingSameId) {
        this.checkDuplicateId(newId, otherPath);
      }
    }

    fs.mkdirSync(newDir, { recursive: true });
    fs.writeFileSync(newPath, yaml.dump(this.buildYamlData(input)), 'utf8');

    // Delete old file if the id changed or privacy changed
    if (oldScriptId !== newId || isPrivate !== wasPrivate) {
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }

    return {
      id: newId,
      folder: newFolder,
      name: input.name,
      description: input.description ?? '',
      type: input.type,
      script: input.script,
      ...(input.scriptFile ? { scriptFile: input.scriptFile } : {}),
      source: isPrivate ? 'private' : 'user',
      ...(input.inputs?.length ? { inputs: input.inputs } : {}),
      ...(input.filterUserDebug ? { filterUserDebug: true } : {}),
      ...(input.formatJson ? { formatJson: true } : {}),
    };
  }

  deleteScript(scriptId: string, isPrivate = false): void {
    const basePath = isPrivate ? this.paths.privatePath : this.paths.userPath;
    const parts = scriptId.split('/');
    const folder = parts.slice(0, -1).join('/');
    const basename = parts[parts.length - 1];
    const filePath = path.join(basePath, folder, `${basename}.yaml`);
    if (!fs.existsSync(filePath)) {
      throw new Error('Cannot delete: script not found.');
    }
    fs.unlinkSync(filePath);
  }

  private checkDuplicateId(id: string, otherBasePath: string): void {
    if (!otherBasePath || !fs.existsSync(otherBasePath)) return;
    const parts = id.split('/');
    const folder = parts.slice(0, -1).join('/');
    const basename = parts[parts.length - 1];
    const otherFile = path.join(otherBasePath, folder, `${basename}.yaml`);
    const otherFileYml = path.join(otherBasePath, folder, `${basename}.yml`);
    if (fs.existsSync(otherFile) || fs.existsSync(otherFileYml)) {
      throw new Error(
        `A script with the same category and name already exists in the ${otherBasePath.includes('/private/') ? 'private' : 'shared'} folder.`,
      );
    }
  }

  private buildYamlData(input: SaveScriptInput): Record<string, unknown> {
    const data: Record<string, unknown> = { name: input.name };
    if (input.description) data.description = input.description;
    const serializedInputs = this.serializeInputs(input.inputs);
    if (serializedInputs) data.inputs = serializedInputs;
    if (input.scriptFile) {
      if (input.type === 'apex') data['apex-file'] = input.scriptFile;
      else if (input.type === 'js') data['js-file'] = input.scriptFile;
      else data['command-file'] = input.scriptFile;
    } else {
      if (input.type === 'apex') data.apex = input.script;
      else if (input.type === 'js') data.js = input.script;
      else data.command = input.script;
    }
    if (input.type === 'apex' && input.filterUserDebug) data['filter-user-debug'] = true;
    if (input.type === 'apex' && input.formatJson) data['format-json'] = true;
    return data;
  }

  private validateScriptFile(scriptFile: string): void {
    if (!this.paths.workspaceRoot) {
      throw new Error('Cannot resolve file path: no workspace folder is open.');
    }
    const absPath = path.resolve(this.paths.workspaceRoot, scriptFile);
    const rootResolved = path.resolve(this.paths.workspaceRoot);
    if (!absPath.startsWith(rootResolved + path.sep) && absPath !== rootResolved) {
      throw new Error('Script file must be inside the workspace folder.');
    }
    if (!fs.existsSync(absPath)) {
      throw new Error(`Script file not found: ${scriptFile}`);
    }
  }

  private parseInputs(raw: unknown[] | undefined): ScriptInput[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (inp): inp is Record<string, unknown> =>
          !!inp &&
          typeof inp === 'object' &&
          typeof (inp as Record<string, unknown>).name === 'string' &&
          ((inp as Record<string, unknown>).name as string).trim() !== '',
      )
      .map((inp) => {
        const entry: ScriptInput = { name: (inp.name as string).trim() };
        if (inp.label && typeof inp.label === 'string') entry.label = inp.label;
        if (inp.type === 'picklist') {
          entry.type = 'picklist';
          if (Array.isArray(inp.options)) {
            entry.options = inp.options.filter((o): o is string => typeof o === 'string');
          }
        } else if (inp.type === 'checkbox') {
          entry.type = 'checkbox';
          if (inp.default === true) entry.default = true;
        } else if (inp.type === 'textarea') {
          entry.type = 'textarea';
        }
        if (inp.required === true) entry.required = true;
        return entry;
      });
  }

  private serializeInputs(inputs?: ScriptInput[]): Record<string, unknown>[] | undefined {
    if (!inputs?.length) return undefined;
    return inputs.map((inp) => {
      const entry: Record<string, unknown> = { name: inp.name };
      if (inp.label && inp.label !== inp.name) entry.label = inp.label;
      if (inp.type === 'picklist') {
        entry.type = 'picklist';
        if (inp.options?.length) entry.options = inp.options;
      } else if (inp.type === 'checkbox') {
        entry.type = 'checkbox';
        if (inp.default) entry.default = true;
      } else if (inp.type === 'textarea') {
        entry.type = 'textarea';
      }
      if (inp.required) entry.required = true;
      return entry;
    });
  }

  private toSlug(name: string): string {
    return (
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'script'
    );
  }

  private parseScript(
    filePath: string,
    id: string,
    folder: string,
    source: YamlSource,
  ): YamlScript | null {
    const basename = path.basename(filePath, path.extname(filePath));

    const content = this.readRawYamlFile(filePath);
    if (content === null) return null;

    const parseResult = this.parseYamlContent(content, id, folder, source, basename);
    if ('invalid' in parseResult) return parseResult;

    const parsedInputs = this.parseInputs(parseResult.inputs);

    const validationError = this.validateYamlDoc(parseResult, id, folder, source, parsedInputs);
    if (validationError) return validationError;

    const { type, scriptFile } = this.detectScriptKind(parseResult);

    const resolved = this.resolveScriptContent(
      parseResult,
      id,
      folder,
      source,
      parsedInputs,
      type,
      scriptFile,
    );
    if ('invalid' in resolved) return resolved.invalid;

    return {
      id,
      folder,
      name: parseResult.name!,
      description: parseResult.description ?? '',
      type,
      script: resolved.content,
      ...(scriptFile ? { scriptFile } : {}),
      source,
      ...(parsedInputs.length ? { inputs: parsedInputs } : {}),
      ...(type === 'apex' && (parseResult as ParsedYamlDoc)['filter-user-debug']
        ? { filterUserDebug: true }
        : {}),
      ...(type === 'apex' && (parseResult as ParsedYamlDoc)['format-json']
        ? { formatJson: true }
        : {}),
    };
  }

  private readRawYamlFile(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      return null;
    }
  }

  private parseYamlContent(
    content: string,
    id: string,
    folder: string,
    source: 'builtin' | 'user' | 'private',
    basename: string,
  ): ParsedYamlDoc | YamlScript {
    let parsed: ParsedYamlDoc;
    try {
      parsed = yaml.load(content) as ParsedYamlDoc;
    } catch (err) {
      return this.makeInvalidScript(
        { id, folder, name: basename, description: '', source },
        `Invalid YAML: ${(err as Error).message}`,
      );
    }

    if (!parsed || typeof parsed !== 'object') {
      return this.makeInvalidScript(
        { id, folder, name: basename, description: '', source },
        'File is empty or not a YAML object',
      );
    }

    return parsed;
  }

  private validateYamlDoc(
    parsed: ParsedYamlDoc,
    id: string,
    folder: string,
    source: 'builtin' | 'user' | 'private',
    parsedInputs: ScriptInput[],
  ): YamlScript | null {
    const base = {
      id,
      folder,
      source,
      description: parsed.description ?? '',
      inputs: parsedInputs,
    };

    if (!parsed.name) {
      return this.makeInvalidScript(
        { ...base, name: id.split('/').pop() ?? id },
        "Missing required field: 'name'",
      );
    }

    const scriptFields = [
      parsed.apex,
      parsed.command,
      parsed.js,
      parsed['apex-file'],
      parsed['command-file'],
      parsed['js-file'],
    ].filter(Boolean);

    if (scriptFields.length > 1) {
      return this.makeInvalidScript(
        { ...base, name: parsed.name },
        "Ambiguous: multiple script fields set (use exactly one of 'apex', 'command', 'js', 'apex-file', 'command-file', or 'js-file')",
      );
    }

    if (scriptFields.length === 0) {
      return this.makeInvalidScript(
        { ...base, name: parsed.name },
        "Missing required field: 'apex', 'command', 'js', 'apex-file', 'command-file', or 'js-file'",
      );
    }

    return null;
  }

  private detectScriptKind(parsed: ParsedYamlDoc): {
    type: 'apex' | 'command' | 'js';
    isFileRef: boolean;
    scriptFile: string | undefined;
  } {
    const isFileRef = !parsed.apex && !parsed.js && !parsed.command;
    const type =
      parsed.apex || parsed['apex-file']
        ? 'apex'
        : parsed.js || parsed['js-file']
          ? 'js'
          : 'command';
    const scriptFile = isFileRef
      ? (parsed['apex-file'] ?? parsed['js-file'] ?? parsed['command-file'])
      : undefined;
    return { type, isFileRef, scriptFile };
  }

  private resolveScriptContent(
    parsed: ParsedYamlDoc,
    id: string,
    folder: string,
    source: 'builtin' | 'user' | 'private',
    parsedInputs: ScriptInput[],
    type: 'apex' | 'command' | 'js',
    scriptFile: string | undefined,
  ): { content: string } | { invalid: YamlScript } {
    if (!scriptFile) {
      return { content: (parsed.apex ?? parsed.js ?? parsed.command)! };
    }

    const base = {
      id,
      folder,
      name: parsed.name!,
      description: parsed.description ?? '',
      source,
      type,
      inputs: parsedInputs,
    };

    if (!this.paths.workspaceRoot) {
      return {
        invalid: this.makeInvalidScript(
          base,
          'Cannot resolve file path: no workspace folder is open.',
        ),
      };
    }

    const absPath = path.resolve(this.paths.workspaceRoot, scriptFile);
    const rootResolved = path.resolve(this.paths.workspaceRoot);
    if (!absPath.startsWith(rootResolved + path.sep) && absPath !== rootResolved) {
      return {
        invalid: this.makeInvalidScript(
          { ...base, scriptFile },
          'Script file must be inside the workspace folder.',
        ),
      };
    }

    if (!fs.existsSync(absPath)) {
      return {
        invalid: this.makeInvalidScript(
          { ...base, scriptFile },
          `Script file not found: ${scriptFile}`,
        ),
      };
    }

    try {
      return { content: fs.readFileSync(absPath, 'utf8') };
    } catch (err) {
      return {
        invalid: this.makeInvalidScript(
          { ...base, scriptFile },
          `Failed to read script file: ${(err as Error).message}`,
        ),
      };
    }
  }

  private saveExecutionLog(scriptName: string, debugLog: string): void {
    if (!debugLog) return;
    if (!this.paths.userPath || !path.isAbsolute(this.paths.userPath)) return;
    try {
      const logsDir = path.join(path.dirname(this.paths.userPath), 'logs');
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
        fs.writeFileSync(path.join(logsDir, '.gitignore'), '*\n', 'utf8');
      }
      const slug = scriptName
        .replace(/[^a-z0-9]/gi, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '')
        .toLowerCase();
      const ts = this.localTimestamp();
      fs.writeFileSync(path.join(logsDir, `${slug}_${ts}.log`), debugLog, 'utf8');
    } catch {
      // Silent — log saving must never affect execution result
    }
  }

  private localTimestamp(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  }

  private makeInvalidScript(
    base: {
      id: string;
      folder: string;
      name: string;
      description: string;
      source: 'builtin' | 'user' | 'private';
      type?: 'apex' | 'command' | 'js';
      inputs?: ScriptInput[];
      scriptFile?: string;
    },
    error: string,
  ): YamlScript {
    return {
      id: base.id,
      folder: base.folder,
      name: base.name,
      description: base.description,
      type: base.type ?? 'apex',
      script: '',
      source: base.source,
      invalid: true,
      error,
      ...(base.inputs?.length ? { inputs: base.inputs } : {}),
      ...(base.scriptFile ? { scriptFile: base.scriptFile } : {}),
    };
  }
}

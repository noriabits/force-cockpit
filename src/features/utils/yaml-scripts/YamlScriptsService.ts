import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { createContext, Script } from 'vm';
import type { ConnectionManager } from '../../../salesforce/connection';
import { assertApexSuccess } from '../../apexUtils';
import { runTerminalCommand } from '../../../utils/terminalCommand';

export interface ScriptInput {
  name: string; // variable identifier used in ${name} placeholders
  label?: string; // display label (defaults to name)
  type?: 'string' | 'picklist' | 'checkbox'; // default 'string'
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
  invalid?: true; // present only when the file has a structural problem
  error?: string; // human-readable description of the problem
}

export interface ExecuteScriptResult {
  scriptId: string;
  success: boolean;
  message: string;
  debugLog: string;
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
    const builtIn = this.loadFromPath(this.paths.builtInPath, 'builtin');
    const user = this.loadFromPath(this.paths.userPath, 'user');
    const priv = this.loadFromPath(this.paths.privatePath, 'private');

    // Merge: builtin < user < private (later sources override earlier by same id)
    const map = new Map<string, YamlScript>();
    for (const script of builtIn) {
      map.set(script.id, script);
    }
    for (const script of user) {
      map.set(script.id, script);
    }
    for (const script of priv) {
      map.set(script.id, script);
    }

    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  async executeScript(
    scriptId: string,
    scripts: YamlScript[],
    inputValues?: Record<string, string>,
    signal?: AbortSignal,
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

    // Substitute input placeholders
    const resolvedScript = this.substituteInputs(script, inputValues);

    if (script.type === 'command') {
      return this.executeTerminalCommand({ ...script, script: resolvedScript }, signal);
    }

    if (script.type === 'js') {
      return this.executeJs({ ...script, script: resolvedScript }, signal);
    }

    try {
      const result = await this.connectionManager.executeAnonymousWithDebugLog(resolvedScript, {
        logLevels: { Apex_code: 'DEBUG' },
      });
      assertApexSuccess(result);
      return {
        scriptId,
        success: true,
        message: `Script "${script.name}" executed successfully.`,
        debugLog: result.debugLog ?? '',
      };
    } catch (err) {
      return {
        scriptId,
        success: false,
        message: (err as Error).message,
        debugLog: '',
      };
    }
  }

  private substituteInputs(script: YamlScript, values?: Record<string, string>): string {
    if (!script.inputs?.length || !values) return script.script;

    let result = script.script;
    for (const input of script.inputs) {
      const raw = values[input.name] ?? '';
      const escaped = this.escapeForType(raw, script.type);
      const pattern = new RegExp(
        `\\$\\{${input.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}`,
        'g',
      );
      result = result.replace(pattern, escaped);
    }
    return result;
  }

  private escapeForType(value: string, type: 'apex' | 'command' | 'js'): string {
    switch (type) {
      case 'apex':
        return value.replace(/\\/g, '\\\\').replace(/'/g, "''");
      case 'js':
        return JSON.stringify(value).slice(1, -1);
      case 'command':
        return value;
    }
  }

  private async executeJs(script: YamlScript, signal?: AbortSignal): Promise<ExecuteScriptResult> {
    const output: string[] = [];
    const logFn = (...args: unknown[]) => {
      output.push(args.map(String).join(' '));
    };
    const errorFn = (...args: unknown[]) => {
      output.push(`[ERROR] ${args.map(String).join(' ')}`);
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
  ): Promise<ExecuteScriptResult> {
    const result = await runTerminalCommand(
      script.script,
      this.paths.workspaceRoot || undefined,
      signal,
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
    };
  }

  updateScript(
    oldScriptId: string,
    input: SaveScriptInput,
    isPrivate = false,
    wasPrivate = false,
  ): YamlScript {
    const basePath = isPrivate ? this.paths.privatePath : this.paths.userPath;
    if (!basePath || !path.isAbsolute(basePath)) {
      throw new Error('Cannot save: no workspace folder is open. Open a folder in VS Code first.');
    }

    if (input.scriptFile) {
      this.validateScriptFile(input.scriptFile);
    }

    const newSlug = this.toSlug(input.name);
    const newFolder = (input.folder || 'utils').trim();
    const newId = `${newFolder}/${newSlug}`;

    // Block duplicate IDs across shared/private.
    // Skip when the "conflict" in the other path is the old file being moved there.
    if (oldScriptId !== newId || isPrivate !== wasPrivate) {
      const otherPath = isPrivate ? this.paths.userPath : this.paths.privatePath;
      const movingSameId = isPrivate !== wasPrivate && oldScriptId === newId;
      if (!movingSameId) {
        this.checkDuplicateId(newId, otherPath);
      }
    }

    const newDir = path.join(basePath, newFolder);
    const newPath = path.join(newDir, `${newSlug}.yaml`);
    fs.mkdirSync(newDir, { recursive: true });

    const data = this.buildYamlData(input);
    fs.writeFileSync(newPath, yaml.dump(data), 'utf8');

    // Delete old file if the id changed or privacy changed
    const oldBasePath = wasPrivate ? this.paths.privatePath : this.paths.userPath;
    if (oldScriptId !== newId || isPrivate !== wasPrivate) {
      const parts = oldScriptId.split('/');
      const oldFolder = parts.slice(0, -1).join('/');
      const oldBase = parts[parts.length - 1];
      const oldPath = path.join(oldBasePath, oldFolder, `${oldBase}.yaml`);
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

  private loadFromPath(basePath: string, source: 'builtin' | 'user' | 'private'): YamlScript[] {
    if (!basePath || !fs.existsSync(basePath)) {
      return [];
    }

    const scripts: YamlScript[] = [];

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(basePath, { withFileTypes: true });
    } catch {
      return [];
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const parentFolder = entry.name;
      const folderPath = path.join(basePath, parentFolder);

      let folderEntries: fs.Dirent[];
      try {
        folderEntries = fs.readdirSync(folderPath, { withFileTypes: true });
      } catch {
        continue;
      }

      // Process YAML files in this folder
      this.loadYamlFiles(folderPath, parentFolder, source, scripts);

      // Process sub-folders (one level of nesting)
      for (const subEntry of folderEntries) {
        if (!subEntry.isDirectory()) continue;
        const subFolder = `${parentFolder}/${subEntry.name}`;
        const subFolderPath = path.join(folderPath, subEntry.name);
        this.loadYamlFiles(subFolderPath, subFolder, source, scripts);
      }
    }

    return scripts;
  }

  private loadYamlFiles(
    dirPath: string,
    folder: string,
    source: 'builtin' | 'user' | 'private',
    scripts: YamlScript[],
  ): void {
    let files: string[];
    try {
      files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
    } catch {
      return;
    }

    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const basename = path.basename(file, path.extname(file));
      const id = `${folder}/${basename}`;

      let content: string;
      try {
        content = fs.readFileSync(filePath, 'utf8');
      } catch {
        continue; // Unreadable file — skip silently
      }

      let parsed: {
        name?: string;
        description?: string;
        apex?: string;
        command?: string;
        js?: string;
        'apex-file'?: string;
        'command-file'?: string;
        'js-file'?: string;
        inputs?: unknown[];
      };
      try {
        parsed = yaml.load(content) as typeof parsed;
      } catch (err) {
        scripts.push({
          id,
          folder,
          name: basename,
          description: '',
          type: 'apex',
          script: '',
          source,
          invalid: true,
          error: `Invalid YAML: ${(err as Error).message}`,
        });
        continue;
      }

      if (!parsed || typeof parsed !== 'object') {
        scripts.push({
          id,
          folder,
          name: basename,
          description: '',
          type: 'apex',
          script: '',
          source,
          invalid: true,
          error: 'File is empty or not a YAML object',
        });
        continue;
      }

      const parsedInputs = this.parseInputs(parsed.inputs);

      if (!parsed.name) {
        scripts.push({
          id,
          folder,
          name: basename,
          description: '',
          type: 'apex',
          script: '',
          source,
          invalid: true,
          error: "Missing required field: 'name'",
          ...(parsedInputs.length ? { inputs: parsedInputs } : {}),
        });
        continue;
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
        scripts.push({
          id,
          folder,
          name: parsed.name,
          description: parsed.description ?? '',
          type: 'apex',
          script: '',
          source,
          invalid: true,
          error:
            "Ambiguous: multiple script fields set (use exactly one of 'apex', 'command', 'js', 'apex-file', 'command-file', or 'js-file')",
          ...(parsedInputs.length ? { inputs: parsedInputs } : {}),
        });
        continue;
      }

      if (scriptFields.length === 0) {
        scripts.push({
          id,
          folder,
          name: parsed.name,
          description: parsed.description ?? '',
          type: 'apex',
          script: '',
          source,
          invalid: true,
          error:
            "Missing required field: 'apex', 'command', 'js', 'apex-file', 'command-file', or 'js-file'",
          ...(parsedInputs.length ? { inputs: parsedInputs } : {}),
        });
        continue;
      }

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

      let scriptContent: string;
      if (isFileRef && scriptFile) {
        if (!this.paths.workspaceRoot) {
          scripts.push({
            id,
            folder,
            name: parsed.name,
            description: parsed.description ?? '',
            type,
            script: '',
            source,
            invalid: true,
            error: 'Cannot resolve file path: no workspace folder is open.',
            ...(parsedInputs.length ? { inputs: parsedInputs } : {}),
          });
          continue;
        }
        const absPath = path.resolve(this.paths.workspaceRoot, scriptFile);
        const rootResolved = path.resolve(this.paths.workspaceRoot);
        if (!absPath.startsWith(rootResolved + path.sep) && absPath !== rootResolved) {
          scripts.push({
            id,
            folder,
            name: parsed.name,
            description: parsed.description ?? '',
            type,
            script: '',
            scriptFile,
            source,
            invalid: true,
            error: 'Script file must be inside the workspace folder.',
            ...(parsedInputs.length ? { inputs: parsedInputs } : {}),
          });
          continue;
        }
        if (!fs.existsSync(absPath)) {
          scripts.push({
            id,
            folder,
            name: parsed.name,
            description: parsed.description ?? '',
            type,
            script: '',
            scriptFile,
            source,
            invalid: true,
            error: `Script file not found: ${scriptFile}`,
            ...(parsedInputs.length ? { inputs: parsedInputs } : {}),
          });
          continue;
        }
        try {
          scriptContent = fs.readFileSync(absPath, 'utf8');
        } catch (err) {
          scripts.push({
            id,
            folder,
            name: parsed.name,
            description: parsed.description ?? '',
            type,
            script: '',
            scriptFile,
            source,
            invalid: true,
            error: `Failed to read script file: ${(err as Error).message}`,
            ...(parsedInputs.length ? { inputs: parsedInputs } : {}),
          });
          continue;
        }
      } else {
        scriptContent = (parsed.apex ?? parsed.js ?? parsed.command)!;
      }

      scripts.push({
        id,
        folder,
        name: parsed.name,
        description: parsed.description ?? '',
        type,
        script: scriptContent,
        ...(scriptFile ? { scriptFile } : {}),
        source,
        ...(parsedInputs.length ? { inputs: parsedInputs } : {}),
      });
    }
  }
}

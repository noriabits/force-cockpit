import * as fs from 'fs';
import * as path from 'path';
import { toSlug } from '../../../../utils/slug';
import { checkDuplicateId, deleteYamlItem, dumpYaml } from '../../../../utils/yamlRepository';
import type { GatherSpec, SaveScriptInput, ScriptInput, YamlScript } from '../types';

interface RepositoryPaths {
  userPath: string;
  privatePath: string;
  workspaceRoot: string;
}

export class ScriptRepository {
  constructor(private readonly paths: RepositoryPaths) {}

  save(input: SaveScriptInput, isPrivate = false): YamlScript {
    const basePath = isPrivate ? this.paths.privatePath : this.paths.userPath;
    if (!basePath || !path.isAbsolute(basePath)) {
      throw new Error('Cannot save: no workspace folder is open. Open a folder in VS Code first.');
    }

    if (input.scriptFile) this.validateScriptFile(input.scriptFile);

    const slug = toSlug(input.name, 'script');
    const folder = (input.folder || 'utils').trim();
    const id = `${folder}/${slug}`;

    const otherPath = isPrivate ? this.paths.userPath : this.paths.privatePath;
    checkDuplicateId(id, otherPath, {
      noun: 'script',
      otherLabel: isPrivate ? 'shared' : 'private',
    });

    const targetDir = path.join(basePath, folder);
    const targetPath = path.join(targetDir, `${slug}.yaml`);
    fs.mkdirSync(targetDir, { recursive: true });

    const data = this.buildYamlData(input);
    fs.writeFileSync(targetPath, dumpYaml(data), 'utf8');

    return this.toResult(id, folder, input, isPrivate);
  }

  update(
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

    if (input.scriptFile) this.validateScriptFile(input.scriptFile);

    // Block duplicate IDs across shared/private.
    // Skip when the "conflict" in the other path is the old file being moved there.
    if (oldScriptId !== newId || isPrivate !== wasPrivate) {
      const otherPath = isPrivate ? this.paths.userPath : this.paths.privatePath;
      const movingSameId = isPrivate !== wasPrivate && oldScriptId === newId;
      if (!movingSameId) {
        checkDuplicateId(newId, otherPath, {
          noun: 'script',
          otherLabel: isPrivate ? 'shared' : 'private',
        });
      }
    }

    fs.mkdirSync(newDir, { recursive: true });
    fs.writeFileSync(newPath, dumpYaml(this.buildYamlData(input)), 'utf8');

    if (oldScriptId !== newId || isPrivate !== wasPrivate) {
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }

    return this.toResult(newId, newFolder, input, isPrivate);
  }

  delete(scriptId: string, isPrivate = false): void {
    const basePath = isPrivate ? this.paths.privatePath : this.paths.userPath;
    deleteYamlItem(basePath, scriptId, 'script');
  }

  saveExecutionLog(scriptName: string, debugLog: string): void {
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

  // ── Private helpers ──────────────────────────────────────────────────────

  private resolveUpdatePaths(
    oldScriptId: string,
    input: SaveScriptInput,
    isPrivate: boolean,
    wasPrivate: boolean,
  ) {
    const basePath = isPrivate ? this.paths.privatePath : this.paths.userPath;
    if (!basePath || !path.isAbsolute(basePath)) {
      throw new Error('Cannot save: no workspace folder is open. Open a folder in VS Code first.');
    }
    const oldBasePath = wasPrivate ? this.paths.privatePath : this.paths.userPath;
    const newSlug = toSlug(input.name, 'script');
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

  private buildYamlData(input: SaveScriptInput): Record<string, unknown> {
    const data: Record<string, unknown> = { name: input.name };
    if (input.description) data.description = input.description;
    if (input.type === 'ai' && input.model) data.model = input.model;
    const serializedInputs = this.serializeInputs(input.inputs);
    if (serializedInputs) data.inputs = serializedInputs;

    const fileField = {
      apex: 'apex-file',
      js: 'js-file',
      command: 'command-file',
      ai: 'ai-file',
    } as const;
    const inlineField = { apex: 'apex', js: 'js', command: 'command', ai: 'ai' } as const;
    if (input.scriptFile) data[fileField[input.type]] = input.scriptFile;
    else data[inlineField[input.type]] = input.script;

    if (input.type === 'ai') {
      if (input.gather) data.gather = this.buildGatherYaml(input.gather);
      if (input.allowFollowupQueries) data['allow-followup-queries'] = true;
      if (input.allowReadWorkspaceFiles) data['allow-read-workspace-files'] = true;
      if (input.skills?.length) data.skills = input.skills;
    }
    if (input.type === 'apex' && input.filterUserDebug) data['filter-user-debug'] = true;
    if (input.type === 'apex' && input.formatJson) data['format-json'] = true;
    return data;
  }

  private buildGatherYaml(gather: GatherSpec): Record<string, unknown> {
    if (gather.kind === 'apex-file') return { 'apex-file': gather.file ?? gather.value };
    if (gather.kind === 'soql') return { soql: gather.value };
    return { apex: gather.value };
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

  private toResult(
    id: string,
    folder: string,
    input: SaveScriptInput,
    isPrivate: boolean,
  ): YamlScript {
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
      ...(input.type === 'ai' && input.model ? { model: input.model } : {}),
      ...(input.gather ? { gather: input.gather } : {}),
      ...(input.type === 'ai' && input.allowFollowupQueries ? { allowFollowupQueries: true } : {}),
      ...(input.type === 'ai' && input.allowReadWorkspaceFiles
        ? { allowReadWorkspaceFiles: true }
        : {}),
      ...(input.type === 'ai' && input.skills?.length ? { skills: input.skills } : {}),
    };
  }

  private localTimestamp(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  }
}

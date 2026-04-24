import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type { YamlSource } from '../../../../utils/yaml-loader';
import type { ScriptInput, ScriptType, YamlScript } from '../types';

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

interface InvalidBase {
  id: string;
  folder: string;
  name: string;
  description: string;
  source: YamlSource;
  type?: ScriptType;
  inputs?: ScriptInput[];
  scriptFile?: string;
}

export class ScriptParser {
  constructor(private readonly workspaceRoot: string) {}

  parse(filePath: string, id: string, folder: string, source: YamlSource): YamlScript | null {
    const basename = path.basename(filePath, path.extname(filePath));

    const content = this.readRawYamlFile(filePath);
    if (content === null) return null;

    const parseOutcome = this.parseYamlContent(content, id, folder, source, basename);
    if ('invalid' in parseOutcome) return parseOutcome;
    const doc: ParsedYamlDoc = parseOutcome;

    const parsedInputs = this.parseInputs(doc.inputs);

    const validationError = this.validateYamlDoc(doc, id, folder, source, parsedInputs);
    if (validationError) return validationError;

    const { type, scriptFile } = this.detectScriptKind(doc);

    const resolved = this.resolveScriptContent(
      doc,
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
      name: doc.name!,
      description: doc.description ?? '',
      type,
      script: resolved.content,
      ...(scriptFile ? { scriptFile } : {}),
      source,
      ...(parsedInputs.length ? { inputs: parsedInputs } : {}),
      ...(type === 'apex' && doc['filter-user-debug'] ? { filterUserDebug: true } : {}),
      ...(type === 'apex' && doc['format-json'] ? { formatJson: true } : {}),
    };
  }

  // ── Validation / detection / resolution ─────────────────────────────────

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
    source: YamlSource,
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
    source: YamlSource,
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
    type: ScriptType;
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
    source: YamlSource,
    parsedInputs: ScriptInput[],
    type: ScriptType,
    scriptFile: string | undefined,
  ): { content: string } | { invalid: YamlScript } {
    if (!scriptFile) {
      return { content: (parsed.apex ?? parsed.js ?? parsed.command)! };
    }

    const base: InvalidBase = {
      id,
      folder,
      name: parsed.name!,
      description: parsed.description ?? '',
      source,
      type,
      inputs: parsedInputs,
    };

    if (!this.workspaceRoot) {
      return {
        invalid: this.makeInvalidScript(
          base,
          'Cannot resolve file path: no workspace folder is open.',
        ),
      };
    }

    const absPath = path.resolve(this.workspaceRoot, scriptFile);
    const rootResolved = path.resolve(this.workspaceRoot);
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

  // ── Inputs parsing ───────────────────────────────────────────────────────

  parseInputs(raw: unknown[] | undefined): ScriptInput[] {
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

  // ── Invalid-script factory ───────────────────────────────────────────────

  makeInvalidScript(base: InvalidBase, error: string): YamlScript {
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

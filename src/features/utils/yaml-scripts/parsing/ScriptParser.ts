import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type { YamlSource } from '../../../../utils/yaml-loader';
import type { GatherSpec, RestSpec, ScriptInput, ScriptType, YamlScript } from '../types';
import { resolveWorkspaceFile } from './workspaceFile';
import { hasRestKey, parseRestSpec, restBody, restBodyFile, type ParsedRest } from './restSpec';
import { parseThenSteps } from './thenSpec';
import { buildYamlScript } from './buildScript';

type ParsedGather = {
  apex?: string;
  'apex-file'?: string;
  soql?: string;
};

type ParsedYamlDoc = {
  name?: string;
  description?: string;
  apex?: string;
  command?: string;
  js?: string;
  ai?: string;
  'apex-file'?: string;
  'command-file'?: string;
  'js-file'?: string;
  'ai-file'?: string;
  inputs?: unknown[];
  then?: unknown;
  'filter-user-debug'?: boolean;
  'format-json'?: boolean;
  // ── ai-only ──
  model?: string;
  gather?: ParsedGather;
  'allow-followup-queries'?: boolean;
  'allow-read-workspace-files'?: boolean;
  skills?: unknown;
  // ── rest-only ──
  rest?: ParsedRest;
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
    if ('invalid' in parseOutcome) return parseOutcome.invalid;
    const doc: ParsedYamlDoc = parseOutcome.doc;

    const parsedInputs = this.parseInputs(doc.inputs);

    const validationError = this.validateYamlDoc(doc, id, folder, source, parsedInputs);
    if (validationError) return validationError;

    const { type, scriptFile } = this.detectScriptKind(doc);

    // Validated before the body is resolved: a malformed request line makes the
    // script unrunnable regardless of whether its `body-file` reads cleanly, and
    // reporting the request-line error first is the more actionable message.
    let rest: RestSpec | undefined;
    if (type === 'rest') {
      const restOutcome = parseRestSpec(doc.rest);
      if ('error' in restOutcome) {
        return this.invalidCard(doc, id, folder, source, type, parsedInputs, restOutcome.error);
      }
      rest = restOutcome.rest;
    }

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

    // The gather (data) step is optional for AI scripts: a script may rely
    // solely on its prompt + user inputs. Only validate gather when one is set.
    let gather: GatherSpec | undefined;
    if (type === 'ai' && doc.gather != null) {
      const gatherOutcome = this.resolveGather(doc, id, folder, source, doc.name!, parsedInputs);
      if ('invalid' in gatherOutcome) return gatherOutcome.invalid;
      gather = gatherOutcome.gather;
    }

    const thenOutcome = parseThenSteps(doc.then);
    if ('error' in thenOutcome) {
      return this.invalidCard(doc, id, folder, source, type, parsedInputs, thenOutcome.error);
    }

    return buildYamlScript({
      id,
      folder,
      name: doc.name!,
      description: doc.description,
      type,
      source,
      script: resolved.content,
      scriptFile,
      inputs: parsedInputs,
      then: thenOutcome.steps,
      apex: {
        filterUserDebug: doc['filter-user-debug'],
        formatJson: doc['format-json'],
      },
      ai: {
        model: doc.model,
        gather,
        allowFollowupQueries: doc['allow-followup-queries'],
        allowReadWorkspaceFiles: doc['allow-read-workspace-files'],
        skills: this.parseSkills(doc.skills),
      },
      rest,
    });
  }

  /** Normalise the `skills:` field to a list of non-empty string ids. */
  private parseSkills(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((s): s is string => typeof s === 'string' && s.trim() !== '')
      .map((s) => s.trim());
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
  ): { doc: ParsedYamlDoc } | { invalid: YamlScript } {
    let parsed: ParsedYamlDoc;
    try {
      parsed = yaml.load(content) as ParsedYamlDoc;
    } catch (err) {
      return {
        invalid: this.makeInvalidScript(
          { id, folder, name: basename, description: '', source },
          `Invalid YAML: ${(err as Error).message}`,
        ),
      };
    }

    if (!parsed || typeof parsed !== 'object') {
      return {
        invalid: this.makeInvalidScript(
          { id, folder, name: basename, description: '', source },
          'File is empty or not a YAML object',
        ),
      };
    }

    return { doc: parsed };
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
      parsed.ai,
      parsed['apex-file'],
      parsed['command-file'],
      parsed['js-file'],
      parsed['ai-file'],
      // `rest` is a block, not a code string. A bare `rest:` (YAML null) still
      // means "this is a rest script" — counting it here routes it to
      // resolveRest's specific error instead of the generic missing-field one.
      hasRestKey(parsed) || undefined,
    ].filter(Boolean);

    if (scriptFields.length > 1) {
      return this.makeInvalidScript(
        { ...base, name: parsed.name },
        "Ambiguous: multiple script fields set (use exactly one of 'apex', 'command', 'js', 'ai', 'rest', 'apex-file', 'command-file', 'js-file', or 'ai-file')",
      );
    }

    if (scriptFields.length === 0) {
      return this.makeInvalidScript(
        { ...base, name: parsed.name },
        "Missing required field: 'apex', 'command', 'js', 'ai', 'rest', 'apex-file', 'command-file', 'js-file', or 'ai-file'",
      );
    }

    return null;
  }

  private detectScriptKind(parsed: ParsedYamlDoc): {
    type: ScriptType;
    isFileRef: boolean;
    scriptFile: string | undefined;
  } {
    // `rest` is checked first: `command` is the fallthrough default below, so a
    // rest script reaching that ternary would be silently mistyped.
    if (hasRestKey(parsed)) {
      const scriptFile = restBodyFile(parsed.rest);
      return { type: 'rest', isFileRef: scriptFile !== undefined, scriptFile };
    }

    const isFileRef = !parsed.apex && !parsed.js && !parsed.command && !parsed.ai;
    const type: ScriptType =
      parsed.apex || parsed['apex-file']
        ? 'apex'
        : parsed.js || parsed['js-file']
          ? 'js'
          : parsed.ai || parsed['ai-file']
            ? 'ai'
            : 'command';
    const scriptFile = isFileRef
      ? (parsed['apex-file'] ?? parsed['js-file'] ?? parsed['command-file'] ?? parsed['ai-file'])
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
      if (type === 'rest') {
        return { content: restBody(parsed.rest) };
      }
      return { content: (parsed.apex ?? parsed.js ?? parsed.command ?? parsed.ai)! };
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

    const resolved = resolveWorkspaceFile(this.workspaceRoot, scriptFile);
    if ('error' in resolved) {
      const withFile = resolved.error.includes('no workspace folder')
        ? base
        : { ...base, scriptFile };
      return { invalid: this.makeInvalidScript(withFile, resolved.error) };
    }
    return { content: resolved.content };
  }

  // ── ai gather step ────────────────────────────────────────────────────────

  private resolveGather(
    parsed: ParsedYamlDoc,
    id: string,
    folder: string,
    source: YamlSource,
    name: string,
    parsedInputs: ScriptInput[],
  ): { gather: GatherSpec } | { invalid: YamlScript } {
    const base: InvalidBase = {
      id,
      folder,
      name,
      description: parsed.description ?? '',
      source,
      type: 'ai',
      inputs: parsedInputs,
    };

    const g = parsed.gather;
    if (!g || typeof g !== 'object') {
      return {
        invalid: this.makeInvalidScript(
          base,
          "AI 'gather' step, when set, must be an object with one of 'apex', 'apex-file', or 'soql'",
        ),
      };
    }

    const fields = [g.apex, g['apex-file'], g.soql].filter(Boolean);
    if (fields.length === 0) {
      return {
        invalid: this.makeInvalidScript(
          base,
          "AI 'gather' must set exactly one of 'apex', 'apex-file', or 'soql'",
        ),
      };
    }
    if (fields.length > 1) {
      return {
        invalid: this.makeInvalidScript(
          base,
          "AI 'gather' is ambiguous: set exactly one of 'apex', 'apex-file', or 'soql'",
        ),
      };
    }

    // Select by truthiness to match the count check above (exactly one field is
    // truthy here) — a `typeof === 'string'` test would mis-pick an empty-string
    // sibling field over the real one.
    if (g.soql) {
      return { gather: { kind: 'soql', value: g.soql } };
    }
    if (g.apex) {
      return { gather: { kind: 'apex', value: g.apex } };
    }

    const file = g['apex-file']!;
    const resolved = resolveWorkspaceFile(this.workspaceRoot, file);
    if ('error' in resolved) {
      return { invalid: this.makeInvalidScript({ ...base, scriptFile: file }, resolved.error) };
    }
    return { gather: { kind: 'apex-file', value: resolved.content, file } };
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

  /**
   * An invalid card for a document that already parsed far enough to know its
   * name, type and inputs — the shape every failure inside `parse()` needs.
   * The helpers that validate their own sub-block (`resolveGather`) build the
   * base themselves because they hold it across several exits.
   */
  private invalidCard(
    doc: ParsedYamlDoc,
    id: string,
    folder: string,
    source: YamlSource,
    type: ScriptType,
    inputs: ScriptInput[],
    error: string,
  ): YamlScript {
    return this.makeInvalidScript(
      {
        id,
        folder,
        name: doc.name!,
        description: doc.description ?? '',
        source,
        type,
        inputs,
      },
      error,
    );
  }

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

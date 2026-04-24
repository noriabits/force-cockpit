import type { ScriptType, YamlScript } from '../types';

export function escapeForType(value: string, type: ScriptType): string {
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

export function substituteVars(
  code: string,
  vars: Record<string, string>,
  type: ScriptType,
): string {
  let result = code;
  for (const [key, raw] of Object.entries(vars)) {
    const escaped = escapeForType(raw, type);
    const pattern = new RegExp(`\\$\\{${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}`, 'g');
    result = result.replace(pattern, escaped);
  }
  return result;
}

export function substituteInputs(script: YamlScript, values?: Record<string, string>): string {
  if (!script.inputs?.length || !values) return script.script;
  const vars = Object.fromEntries(script.inputs.map((inp) => [inp.name, values[inp.name] ?? '']));
  return substituteVars(script.script, vars, script.type);
}

export function substituteSystemPlaceholders(
  content: string,
  scriptType: ScriptType,
  systemVars: Record<string, string>,
): string {
  return substituteVars(content, systemVars, scriptType);
}

export function validateRequiredInputs(
  script: YamlScript,
  values?: Record<string, string>,
): string | null {
  if (!script.inputs?.length) return null;
  for (const inp of script.inputs) {
    if (inp.required && !values?.[inp.name]?.trim()) {
      return `Required input "${inp.label || inp.name}" is missing.`;
    }
  }
  return null;
}

/**
 * Pure save-time logic for the YAML script form: input-row cleaning/validation
 * and save-payload assembly. No DOM access, so it can be unit-tested in
 * isolation from script-form.js's DOM wiring.
 */

export type RawFormInput = {
  name: string;
  label: string;
  type: 'string' | 'picklist' | 'checkbox' | 'textarea';
  required: boolean;
  options: string;
  checkboxDefault: boolean;
};

export type CleanedInput = {
  name: string;
  label?: string;
  type?: 'picklist' | 'checkbox' | 'textarea';
  required?: boolean;
  options?: string[];
  default?: boolean;
};

export type AiFieldsPayload = {
  model: string;
  gather?: { kind: 'soql' | 'apex' | 'apex-file'; value: string; file?: string };
  skills?: string[];
  allowFollowupQueries?: boolean;
  allowReadWorkspaceFiles?: boolean;
};

export function cleanInputs(rawInputs: RawFormInput[]): CleanedInput[] {
  return rawInputs
    .filter((inp) => inp.name.trim())
    .map((inp) => {
      const entry: CleanedInput = { name: inp.name.trim() };
      if (inp.label.trim()) entry.label = inp.label.trim();
      if (inp.type === 'picklist') {
        entry.type = 'picklist';
        entry.options = inp.options
          .split(',')
          .map((o) => o.trim())
          .filter(Boolean);
      } else if (inp.type === 'checkbox') {
        entry.type = 'checkbox';
        if (inp.checkboxDefault) entry.default = true;
      } else if (inp.type === 'textarea') {
        entry.type = 'textarea';
      }
      if (inp.required) entry.required = true;
      return entry;
    });
}

/** Returns a labels-object error key (see labels.js) on the first invalid input, or null. */
export function validateInputs(cleanedInputs: CleanedInput[]): string | null {
  const inputNames = new Set<string>();
  for (const inp of cleanedInputs) {
    if (!/^[a-zA-Z_]\w*$/.test(inp.name)) return 'errorInputNameInvalid';
    if (inputNames.has(inp.name)) return 'errorInputNameDuplicate';
    if (inp.type === 'picklist' && (!inp.options || inp.options.length === 0)) {
      return 'errorPicklistOptionsRequired';
    }
    inputNames.add(inp.name);
  }
  return null;
}

export function buildScriptPayload(opts: {
  name: string;
  description: string;
  type: 'apex' | 'command' | 'js' | 'ai';
  folder: string;
  isFile: boolean;
  filePath: string;
  content: string;
  inputs: CleanedInput[];
  filterUserDebug: boolean;
  formatJson: boolean;
  aiFields?: AiFieldsPayload;
}) {
  return {
    name: opts.name,
    description: opts.description,
    type: opts.type,
    folder: opts.folder,
    script: opts.isFile ? '' : opts.content,
    ...(opts.isFile ? { scriptFile: opts.filePath } : {}),
    inputs: opts.inputs,
    ...(opts.type === 'apex' && opts.filterUserDebug ? { filterUserDebug: true } : {}),
    ...(opts.type === 'apex' && opts.formatJson ? { formatJson: true } : {}),
    ...(opts.type === 'ai' && opts.aiFields ? opts.aiFields : {}),
  };
}

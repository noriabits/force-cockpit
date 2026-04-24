export type ScriptType = 'apex' | 'command' | 'js';

export interface ScriptInput {
  name: string;
  label?: string;
  type?: 'string' | 'picklist' | 'checkbox' | 'textarea';
  required?: boolean;
  options?: string[];
  default?: boolean;
}

export interface YamlScript {
  id: string;
  folder: string;
  name: string;
  description: string;
  type: ScriptType;
  script: string;
  scriptFile?: string;
  source: 'builtin' | 'user' | 'private';
  inputs?: ScriptInput[];
  filterUserDebug?: boolean;
  formatJson?: boolean;
  invalid?: true;
  error?: string;
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
  type: ScriptType;
  folder: string;
  script: string;
  scriptFile?: string;
  inputs?: ScriptInput[];
  filterUserDebug?: boolean;
  formatJson?: boolean;
}

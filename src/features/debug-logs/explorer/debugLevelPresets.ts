// Named debug-level presets. Every preset carries the copy the UI shows, so a
// user who doesn't know the category matrix can still pick correctly: the
// dropdown renders `label` + `whenToUse`, and the hint line under the picker
// shows `description` plus the resulting levels.
import type { CategoryLevels, DebugLevelPreset, LogCategory, LogLevel } from './types';

export const LOG_CATEGORIES: LogCategory[] = [
  'ApexCode',
  'ApexProfiling',
  'Callout',
  'Database',
  'System',
  'Validation',
  'Visualforce',
  'Workflow',
];

export const LOG_LEVELS: LogLevel[] = [
  'NONE',
  'ERROR',
  'WARN',
  'INFO',
  'DEBUG',
  'FINE',
  'FINER',
  'FINEST',
];

function levels(
  ApexCode: LogLevel,
  ApexProfiling: LogLevel,
  Callout: LogLevel,
  Database: LogLevel,
  System: LogLevel,
  Validation: LogLevel,
  Visualforce: LogLevel,
  Workflow: LogLevel,
): CategoryLevels {
  return {
    ApexCode,
    ApexProfiling,
    Callout,
    Database,
    System,
    Validation,
    Visualforce,
    Workflow,
  };
}

export const DEBUG_LEVEL_PRESETS: DebugLevelPreset[] = [
  {
    id: 'balanced',
    label: 'Balanced',
    recommended: true,
    whenToUse: 'Start here when you are not sure which to pick.',
    description:
      'Captures your System.debug output, which classes and triggers ran, every SOQL and DML ' +
      'statement, and the governor-limit summary — enough to diagnose most problems without ' +
      'filling the log budget. Switch to a focused preset once you know where the problem is.',
    levels: levels('DEBUG', 'INFO', 'INFO', 'INFO', 'DEBUG', 'INFO', 'INFO', 'INFO'),
  },
  {
    id: 'user-debug-only',
    label: 'USER_DEBUG only (quiet)',
    whenToUse: 'You only care about your own System.debug() lines.',
    description:
      'The smallest, most readable log possible: your debug statements and little else. Good ' +
      'for a long trace, or a busy user where anything richer would truncate.',
    levels: levels('DEBUG', 'NONE', 'NONE', 'NONE', 'ERROR', 'NONE', 'NONE', 'NONE'),
  },
  {
    id: 'soql-deep-dive',
    label: 'SOQL / database deep dive',
    whenToUse: 'A query is slow, non-selective, or returns the wrong rows.',
    description:
      'Full query text, row counts and per-query timing for every SOQL, SOSL and DML ' +
      'statement. This is the preset that exposes SOQL-in-a-loop and N+1 patterns.',
    levels: levels('FINE', 'INFO', 'NONE', 'FINEST', 'INFO', 'INFO', 'NONE', 'INFO'),
  },
  {
    id: 'flow-process',
    label: 'Flow & Process Builder',
    whenToUse: 'A Flow or record-triggered automation misbehaves.',
    description:
      'Workflow at FINER is the level that logs flow elements together with their variable ' +
      'values, so you can see which decision branch ran and what it was looking at.',
    levels: levels('DEBUG', 'NONE', 'NONE', 'INFO', 'INFO', 'INFO', 'NONE', 'FINER'),
  },
  {
    id: 'integration-callouts',
    label: 'Integration / callouts',
    whenToUse: 'An outbound HTTP or SOAP callout fails or returns something odd.',
    description:
      'Logs the full request and response bodies of every callout, plus the Apex around it.',
    levels: levels('DEBUG', 'NONE', 'FINEST', 'INFO', 'INFO', 'NONE', 'NONE', 'NONE'),
  },
  {
    id: 'limits-performance',
    label: 'Governor limits / performance',
    whenToUse: 'The transaction hits — or nearly hits — a limit.',
    description:
      'ApexProfiling at FINEST gives the full cumulative-usage breakdown: CPU time, heap, ' +
      'SOQL, DML, rows and callouts, per namespace.',
    levels: levels('INFO', 'FINEST', 'NONE', 'INFO', 'INFO', 'NONE', 'NONE', 'INFO'),
  },
  {
    id: 'deep-trace',
    label: 'Deep trace (FINEST)',
    truncationWarning: true,
    whenToUse: 'Last resort for a bug nothing else explains.',
    description:
      'Every statement, variable assignment and heap allocation. This fills the 20 MB log ' +
      'budget quickly and truncates — prefer pairing it with a class trace on the suspect ' +
      'class rather than applying it to a whole user.',
    levels: levels('FINEST', 'FINEST', 'FINEST', 'FINEST', 'FINEST', 'FINEST', 'FINEST', 'FINEST'),
  },
  {
    id: 'production-safe',
    label: 'Production-safe (errors only)',
    whenToUse: 'Tracing on production or a busy integration user.',
    description:
      'Records failures and almost nothing else, keeping log volume and the performance ' +
      'overhead of logging to a minimum.',
    levels: levels('ERROR', 'NONE', 'ERROR', 'ERROR', 'ERROR', 'ERROR', 'NONE', 'ERROR'),
  },
];

export const RECOMMENDED_PRESET_ID = 'balanced';

export function findPreset(id: string): DebugLevelPreset | undefined {
  return DEBUG_LEVEL_PRESETS.find((p) => p.id === id);
}

/** `ForceCockpit_Balanced` — the DeveloperName of the DebugLevel record a preset maps to. */
export function presetDeveloperName(preset: DebugLevelPreset): string {
  const camel = preset.id
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return `ForceCockpit_${camel}`;
}

/** Compact display form, e.g. `APEX_CODE,DEBUG; DB,INFO; …` (non-NONE categories only). */
export function describeLevels(levelsMap: CategoryLevels): string {
  const shortNames: Record<LogCategory, string> = {
    ApexCode: 'APEX_CODE',
    ApexProfiling: 'APEX_PROFILING',
    Callout: 'CALLOUT',
    Database: 'DB',
    System: 'SYSTEM',
    Validation: 'VALIDATION',
    Visualforce: 'VISUALFORCE',
    Workflow: 'WORKFLOW',
  };
  return LOG_CATEGORIES.filter((c) => levelsMap[c] !== 'NONE')
    .map((c) => `${shortNames[c]},${levelsMap[c]}`)
    .join('; ');
}

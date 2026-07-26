// Parses the ```debug-level fenced block the AI analysis ends with, so the UI
// can offer a one-click "Apply these levels" back into the trace-flag form.
// Pure and defensive: the model can emit anything, and a malformed block must
// simply mean "no suggestion" rather than breaking the panel.
import type { CategoryLevels, LogCategory, LogLevel } from '../types';

const CATEGORIES: LogCategory[] = [
  'ApexCode',
  'ApexProfiling',
  'Callout',
  'Database',
  'System',
  'Validation',
  'Visualforce',
  'Workflow',
];

const LEVELS: LogLevel[] = ['NONE', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'FINE', 'FINER', 'FINEST'];

export interface LevelSuggestion {
  presetId?: string;
  levels?: CategoryLevels;
  reason?: string;
}

const FENCE_RE = /```debug-level\s*\n([\s\S]*?)```/i;

export function parseLevelSuggestion(analysis: string): LevelSuggestion | null {
  const match = FENCE_RE.exec(analysis);
  if (!match) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1].trim());
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  const suggestion: LevelSuggestion = {};
  if (typeof obj.preset === 'string' && obj.preset.trim()) suggestion.presetId = obj.preset.trim();
  if (typeof obj.reason === 'string' && obj.reason.trim()) suggestion.reason = obj.reason.trim();

  if (typeof obj.levels === 'object' && obj.levels !== null) {
    const raw = obj.levels as Record<string, unknown>;
    const levels = {} as CategoryLevels;
    let complete = true;
    for (const category of CATEGORIES) {
      const value = String(raw[category] ?? '').toUpperCase() as LogLevel;
      if (LEVELS.includes(value)) levels[category] = value;
      // A partial block is still useful — fill the gaps with NONE.
      else {
        levels[category] = 'NONE';
        complete = false;
      }
    }
    // Ignore a block where nothing at all matched: it carries no information.
    if (complete || CATEGORIES.some((c) => levels[c] !== 'NONE')) suggestion.levels = levels;
  }

  return suggestion.presetId || suggestion.levels ? suggestion : null;
}

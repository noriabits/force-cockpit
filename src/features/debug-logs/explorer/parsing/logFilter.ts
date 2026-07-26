// Pure viewer filtering: which parsed lines survive the category chips, the
// noise toggle and the text search. Returns line indices so the caller can
// render a slice without copying the whole log.
import type { LogEvent } from '../types';
import { groupOf, NOISE_GROUPS, type EventGroup } from './eventCategories';

export interface LogFilterOptions {
  /** Selected chips; empty means "all groups". */
  groups: EventGroup[];
  /** Case-insensitive substring match over the raw line. */
  text: string;
  /** Drop heap/variable/statement chatter. */
  hideNoise: boolean;
  /** Keep continuation lines attached to a kept event (multi-line debug output). */
  keepContinuations: boolean;
}

export const DEFAULT_FILTER: LogFilterOptions = {
  groups: [],
  text: '',
  hideNoise: true,
  keepContinuations: true,
};

/** Indices (0-based, into `events`) of the lines that pass the filter. */
export function filterLines(events: LogEvent[], options: LogFilterOptions): number[] {
  const selected = new Set(options.groups);
  const needle = options.text.trim().toLowerCase();
  const out: number[] = [];
  let lastKept = false;

  for (let i = 0; i < events.length; i++) {
    const event = events[i];

    if (!event.event) {
      // Continuation line: follows whatever its parent event did.
      if (options.keepContinuations && lastKept) out.push(i);
      continue;
    }

    const group = groupOf(event.event);
    let keep = selected.size === 0 || selected.has(group);
    if (keep && options.hideNoise && selected.size === 0 && NOISE_GROUPS.includes(group)) {
      keep = false;
    }
    if (keep && needle) keep = event.raw.toLowerCase().includes(needle);

    lastKept = keep;
    if (keep) out.push(i);
  }
  return out;
}

/** Indices of the lines matching a search term, for prev/next navigation. */
export function findMatches(events: LogEvent[], text: string): number[] {
  const needle = text.trim().toLowerCase();
  if (!needle) return [];
  const out: number[] = [];
  for (let i = 0; i < events.length; i++) {
    if (events[i].raw.toLowerCase().includes(needle)) out.push(i);
  }
  return out;
}

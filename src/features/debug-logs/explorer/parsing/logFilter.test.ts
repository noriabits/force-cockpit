import { describe, expect, it } from 'vitest';
import { DEFAULT_FILTER, filterLines, findMatches } from './logFilter';
import { parseLog } from './logLine';
import { EMPTY_LOG, FATAL_LOG, SUCCESS_LOG } from './__fixtures__/logs';

const events = (log: string) => parseLog(log).events;

describe('filterLines', () => {
  it('hides heap/statement noise by default', () => {
    const parsed = events(EMPTY_LOG);
    const kept = filterLines(parsed, DEFAULT_FILTER).map((i) => parsed[i].event);
    expect(kept).not.toContain('HEAP_ALLOCATE');
    expect(kept).not.toContain('STATEMENT_EXECUTE');
    expect(kept).toContain('EXECUTION_STARTED');
  });

  it('keeps noise when the toggle is off', () => {
    const parsed = events(EMPTY_LOG);
    const kept = filterLines(parsed, { ...DEFAULT_FILTER, hideNoise: false }).map(
      (i) => parsed[i].event,
    );
    expect(kept).toContain('HEAP_ALLOCATE');
  });

  it('restricts to the selected groups', () => {
    const parsed = events(SUCCESS_LOG);
    const kept = filterLines(parsed, { ...DEFAULT_FILTER, groups: ['soql'] }).map(
      (i) => parsed[i].event,
    );
    expect(new Set(kept)).toEqual(new Set(['SOQL_EXECUTE_BEGIN', 'SOQL_EXECUTE_END']));
  });

  it('keeps continuation lines attached to a kept event', () => {
    const parsed = events(FATAL_LOG);
    const kept = filterLines(parsed, { ...DEFAULT_FILTER, groups: ['errors'] });
    const rawKept = kept.map((i) => parsed[i].raw);
    expect(rawKept.some((line) => line.includes('FATAL_ERROR'))).toBe(true);
    expect(rawKept.some((line) => line.includes('line 42'))).toBe(true);
  });

  it('applies the text filter on top of the groups', () => {
    const parsed = events(SUCCESS_LOG);
    const kept = filterLines(parsed, { ...DEFAULT_FILTER, text: 'accounts' });
    expect(kept.length).toBeGreaterThan(0);
    expect(parsed[kept[0]].raw.toLowerCase()).toContain('accounts');
  });
});

describe('findMatches', () => {
  it('returns every matching line index, or nothing for a blank term', () => {
    const parsed = events(SUCCESS_LOG);
    expect(findMatches(parsed, 'SOQL_EXECUTE').length).toBe(2);
    expect(findMatches(parsed, '   ')).toEqual([]);
  });
});

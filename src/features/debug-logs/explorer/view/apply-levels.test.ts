import { describe, expect, it } from 'vitest';
import { parseLevelSuggestion } from './apply-levels';

const wrap = (json: string) =>
  `## Better logging next time\nsome prose\n\`\`\`debug-level\n${json}\n\`\`\`\n`;

describe('parseLevelSuggestion', () => {
  it('reads a preset id and its reason', () => {
    const suggestion = parseLevelSuggestion(
      wrap('{ "preset": "soql-deep-dive", "reason": "row counts are missing" }'),
    );
    expect(suggestion).toEqual({ presetId: 'soql-deep-dive', reason: 'row counts are missing' });
  });

  it('reads explicit category levels', () => {
    const suggestion = parseLevelSuggestion(
      wrap(
        JSON.stringify({
          levels: {
            ApexCode: 'fine',
            ApexProfiling: 'FINEST',
            Callout: 'NONE',
            Database: 'FINEST',
            System: 'INFO',
            Validation: 'NONE',
            Visualforce: 'NONE',
            Workflow: 'INFO',
          },
        }),
      ),
    );
    expect(suggestion?.levels?.ApexCode).toBe('FINE');
    expect(suggestion?.levels?.Database).toBe('FINEST');
  });

  it('fills missing categories with NONE rather than rejecting a partial block', () => {
    const suggestion = parseLevelSuggestion(wrap('{ "levels": { "Database": "FINEST" } }'));
    expect(suggestion?.levels?.Database).toBe('FINEST');
    expect(suggestion?.levels?.Workflow).toBe('NONE');
  });

  it('returns null when there is no block, bad JSON, or nothing usable', () => {
    expect(parseLevelSuggestion('no fenced block here')).toBeNull();
    expect(parseLevelSuggestion(wrap('{ not json '))).toBeNull();
    expect(parseLevelSuggestion(wrap('{ "reason": "just prose" }'))).toBeNull();
    expect(parseLevelSuggestion(wrap('{ "levels": { "Nonsense": "LOUD" } }'))).toBeNull();
  });

  it('ignores other fenced code blocks in the analysis', () => {
    const analysis =
      '```json\n{ "preset": "deep-trace" }\n```\n' + wrap('{ "preset": "balanced" }');
    expect(parseLevelSuggestion(analysis)?.presetId).toBe('balanced');
  });
});

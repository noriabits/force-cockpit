import { describe, expect, it } from 'vitest';
import { parseThenSteps } from './thenSpec';

/** Narrow the result union in a way that fails loudly on the wrong branch. */
function ok(raw: unknown) {
  const result = parseThenSteps(raw);
  if ('error' in result) throw new Error(`expected valid steps, got: ${result.error}`);
  return result.steps;
}

function err(raw: unknown): string {
  const result = parseThenSteps(raw);
  if (!('error' in result)) throw new Error('expected an error, got valid steps');
  return result.error;
}

describe('parseThenSteps', () => {
  it('reads an absent block as no steps rather than an error', () => {
    // `then:` is optional on every script kind, and a bare `then:` is YAML null.
    expect(ok(undefined)).toEqual([]);
    expect(ok(null)).toEqual([]);
    expect(ok([])).toEqual([]);
  });

  it('keeps the declared order and trims the script id', () => {
    expect(ok([{ script: '  cat/first  ' }, { script: 'cat/second' }])).toEqual([
      { script: 'cat/first' },
      { script: 'cat/second' },
    ]);
  });

  it('omits when and with entirely when the step carries neither', () => {
    const [step] = ok([{ script: 'cat/a' }]);
    expect(step).not.toHaveProperty('when');
    expect(step).not.toHaveProperty('with');
  });

  it('keeps a valid when, trimmed', () => {
    expect(ok([{ script: 'cat/a', when: '  "x" === "x"  ' }])).toEqual([
      { script: 'cat/a', when: '"x" === "x"' },
    ]);
  });

  it('drops a whitespace-only when instead of storing a blank guard', () => {
    // `validateWhenExpression` passes a blank expression, so the only thing
    // stopping `when: ''` reaching the runtime chain is this trim check.
    expect(ok([{ script: 'cat/a', when: '   ' }])).toEqual([{ script: 'cat/a' }]);
  });

  it('coerces unquoted scalar with: values to strings', () => {
    // Inputs are always strings; YAML would otherwise hand over `true`/`12`
    // for an unquoted checkbox or number value.
    expect(ok([{ script: 'cat/a', with: { n: 12, flag: true, nil: null } }])).toEqual([
      { script: 'cat/a', with: { n: '12', flag: 'true', nil: '' } },
    ]);
  });

  describe('rejections', () => {
    it('rejects a non-list block', () => {
      expect(err('cat/second')).toContain("'then' must be a list");
      expect(err({ script: 'cat/second' })).toContain("'then' must be a list");
    });

    it('rejects a step that is not an object', () => {
      for (const raw of ['cat/second', 42, null, ['cat/second']]) {
        expect(err([raw])).toContain("must be an object with a 'script' id");
      }
    });

    it('rejects a step with a missing, blank or non-string script id', () => {
      for (const step of [{}, { script: '   ' }, { script: 42 }, { with: { a: 'b' } }]) {
        expect(err([step])).toContain("non-empty 'script' id");
      }
    });

    it('rejects a non-string when, naming the step it belongs to', () => {
      expect(err([{ script: 'cat/a', when: true }])).toContain("'when' on 'then' step \"cat/a\"");
    });

    it("surfaces the when validator's own message for a broken expression", () => {
      // The common mistake: an unquoted comparand is an undefined identifier.
      expect(err([{ script: 'cat/a', when: '${x} !== None' }])).toContain('Unknown name');
      expect(err([{ script: 'cat/a', when: '"a" ===' }])).toContain("Invalid 'when' expression");
    });

    it('rejects a with: that is not a name→value map', () => {
      expect(err([{ script: 'cat/a', with: 'accountId' }])).toContain(
        "'with' on 'then' step \"cat/a\"",
      );
      expect(err([{ script: 'cat/a', with: ['accountId'] }])).toContain('must map input names');
    });

    it('reports the FIRST failing step, not the last', () => {
      expect(err([{ script: 'cat/a' }, { script: '' }, { when: 1 }])).toContain(
        "non-empty 'script' id",
      );
    });

    // Guard order is load-bearing: a step with several problems must keep
    // reporting the one it always did, so a message never moves under an edit.
    it('checks the script id before when, and when before with', () => {
      expect(err([{ script: '', when: true, with: 'nope' }])).toContain("non-empty 'script' id");
      expect(err([{ script: 'cat/a', when: true, with: 'nope' }])).toContain("'when' on 'then'");
    });
  });
});

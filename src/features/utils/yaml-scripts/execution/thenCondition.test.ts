import { describe, expect, it } from 'vitest';
import { evaluateWhen, validateWhenExpression } from './thenCondition';

const vars = {
  cartType: 'Quote',
  status: 'Active',
  flag: 'true',
  off: 'false',
  blank: '',
  zero: '0',
  count: '10',
  name: 'O\'Brien & "Sons"',
};

describe('evaluateWhen', () => {
  it('treats a missing or blank condition as "always run"', () => {
    expect(evaluateWhen(undefined, vars)).toBe(true);
    expect(evaluateWhen('', vars)).toBe(true);
    expect(evaluateWhen('   ', vars)).toBe(true);
  });

  describe('comparison', () => {
    it('compares a placeholder against a quoted literal', () => {
      expect(evaluateWhen('${cartType} === "Quote"', vars)).toBe(true);
      expect(evaluateWhen('${cartType} !== "None"', vars)).toBe(true);
      expect(evaluateWhen('${cartType} === "Order"', vars)).toBe(false);
    });

    it('accepts either quote style, and == as well as ===', () => {
      expect(evaluateWhen("${cartType} === 'Quote'", vars)).toBe(true);
      expect(evaluateWhen('${cartType} == "Quote"', vars)).toBe(true);
    });

    it('compares two placeholders', () => {
      expect(evaluateWhen('${cartType} === ${cartType}', vars)).toBe(true);
      expect(evaluateWhen('${cartType} === ${status}', vars)).toBe(false);
    });

    it('resolves an unknown placeholder to an empty string', () => {
      expect(evaluateWhen('${nope} === ""', vars)).toBe(true);
      expect(evaluateWhen('${nope} !== "Quote"', vars)).toBe(true);
    });
  });

  describe('truthiness', () => {
    it("reads a checkbox naturally — 'true'/'false' arrive as booleans", () => {
      expect(evaluateWhen('${flag}', vars)).toBe(true);
      expect(evaluateWhen('${off}', vars)).toBe(false);
    });

    it('is false for an empty or unpublished value', () => {
      expect(evaluateWhen('${blank}', vars)).toBe(false);
      expect(evaluateWhen('${nope}', vars)).toBe(false);
    });

    it('follows JS for other strings — "0" is a non-empty string, so truthy', () => {
      expect(evaluateWhen('${zero}', vars)).toBe(true);
      expect(evaluateWhen('${zero} === "0"', vars)).toBe(true);
    });
  });

  describe('the whole language is available', () => {
    it('supports && and ||', () => {
      expect(evaluateWhen('${cartType} === "Quote" && ${status} === "Active"', vars)).toBe(true);
      expect(evaluateWhen('${cartType} === "Quote" && ${status} === "Draft"', vars)).toBe(false);
      expect(evaluateWhen('${cartType} === "Order" || ${status} === "Active"', vars)).toBe(true);
    });

    it('supports negation — the thing the old grammar could not express', () => {
      expect(evaluateWhen('!${off}', vars)).toBe(true);
      expect(evaluateWhen('!${flag}', vars)).toBe(false);
      expect(evaluateWhen('!${blank}', vars)).toBe(true);
      expect(evaluateWhen('!(${cartType} === "Order")', vars)).toBe(true);
    });

    it('supports parentheses, which change the grouping', () => {
      expect(evaluateWhen('(${off} || ${flag}) && ${off}', vars)).toBe(false);
      expect(evaluateWhen('(${off} || ${flag}) && ${flag}', vars)).toBe(true);
      expect(evaluateWhen('${off} || (${flag} && ${off})', vars)).toBe(false);
    });

    it('supports string methods', () => {
      expect(evaluateWhen('${cartType}.startsWith("Q")', vars)).toBe(true);
      expect(evaluateWhen('${status}.includes("ctiv")', vars)).toBe(true);
      expect(evaluateWhen('${cartType}.toLowerCase() === "quote"', vars)).toBe(true);
    });

    it('supports ternaries and numeric comparison against a number literal', () => {
      expect(evaluateWhen('${cartType} === "Quote" ? ${flag} : ${off}', vars)).toBe(true);
      expect(evaluateWhen('${count} > 5', vars)).toBe(true);
      expect(evaluateWhen('Number(${count}) > 20', vars)).toBe(false);
    });
  });

  describe('values are literals, never code', () => {
    it('cannot inject an expression through a value', () => {
      expect(evaluateWhen('${name} !== ""', vars)).toBe(true);
      expect(evaluateWhen('${name}.includes("Sons")', vars)).toBe(true);
      expect(evaluateWhen('${x} === "a\\" || true || \\"b"', { x: 'a" || true || "b' })).toBe(true);
    });

    it('a value containing an operator is compared as text', () => {
      expect(evaluateWhen('${x} === "1 === 1"', { x: '1 === 1' })).toBe(true);
      expect(evaluateWhen('${x}', { x: 'false && true' })).toBe(true); // non-empty string
    });

    it('has no host globals in scope', () => {
      // `typeof` on a missing name is the one form that does not throw, so it
      // proves absence directly.
      expect(evaluateWhen('typeof process === "undefined"', vars)).toBe(true);
      expect(evaluateWhen('typeof require === "undefined"', vars)).toBe(true);
      expect(() => evaluateWhen('process.pid', vars)).toThrow(/Could not evaluate/);
      expect(() => evaluateWhen('require("fs")', vars)).toThrow(/Could not evaluate/);
    });
  });

  it('reports an expression it cannot evaluate rather than guessing', () => {
    expect(() => evaluateWhen('${cartType}.nope.deeper', vars)).toThrow(/Could not evaluate/);
  });
});

describe('validateWhenExpression', () => {
  it('accepts a blank condition', () => {
    expect(validateWhenExpression('')).toBeNull();
    expect(validateWhenExpression('   ')).toBeNull();
  });

  const good = [
    '${cartType} !== "None"',
    '${a} === "x" && ${b} === "y"',
    '!${flag}',
    '(${a} || ${b}) && ${c}',
    '${name}.startsWith("TEST-")',
    '${count} > 5',
    '${a} ? ${b} : ${c}',
  ];
  for (const expr of good) {
    it(`accepts ${JSON.stringify(expr)}`, () => {
      expect(validateWhenExpression(expr)).toBeNull();
    });
  }

  it('rejects a syntax error at parse time', () => {
    expect(validateWhenExpression('${a} ===')).toMatch(/Invalid 'when' expression/);
    expect(validateWhenExpression('(${a}')).toMatch(/Invalid 'when' expression/);
    expect(validateWhenExpression('${a} &&& ${b}')).toMatch(/Invalid 'when' expression/);
  });

  it('rejects an unquoted comparand, the easiest mistake to make', () => {
    const error = validateWhenExpression('${cartType} !== None');
    expect(error).toMatch(/Unknown name/);
    expect(error).toMatch(/must be quoted/);
  });

  it('rejects a reference to something not in scope', () => {
    expect(validateWhenExpression('process.exit()')).toMatch(/Unknown name/);
    expect(validateWhenExpression('require("fs")')).toMatch(/Unknown name/);
  });

  it('leaves value-dependent failures to run time', () => {
    expect(validateWhenExpression('${a}.deeper.still')).toBeNull();
  });
});

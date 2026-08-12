import { createContext, Script } from 'vm';

/**
 * Evaluates a `when:` condition on a `then:` step.
 *
 * The condition is a **JavaScript expression**, evaluated in an empty `vm`
 * sandbox with no globals of its own — so the whole language is available and
 * there is no bespoke grammar to learn or to keep discovering the edges of:
 *
 *   when: ${cartType} !== "None"
 *   when: ${cartType} === "Quote" && ${status} === "Active"
 *   when: !${skipCart} || ${force}
 *   when: ${cartType} === "Quote" ? ${hasQuoteAccess} : ${hasOrderAccess}
 *   when: ${name}.startsWith("TEST-")
 *
 * Placeholders are substituted as **literals**, never as raw text, so a value
 * can never inject code: a name containing `"; drop()` arrives as an ordinary
 * quoted string. Because literals are substituted rather than variables bound,
 * a bare word like `None` is an undefined identifier — quote your comparands.
 */

/** `${name}` — the same placeholder syntax used everywhere else in a script. */
const PLACEHOLDER = /\$\{([^}]*)\}/g;

/** Long enough for any sane expression; stops a pathological one wedging a run. */
const EVAL_TIMEOUT_MS = 100;

/**
 * Rewrites the condition into a JS expression by replacing each placeholder
 * with a literal.
 *
 * `'true'` / `'false'` become real booleans so a checkbox reads naturally as
 * `when: ${flag}` — every other input arrives as a string, and the string
 * `"false"` would otherwise be truthy. A placeholder nothing supplied becomes
 * `""`, so `when: ${cartId}` still reads as "only if one was published".
 */
function toExpression(template: string, vars: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (_match, rawName: string) => {
    const value = vars[rawName.trim()];
    if (value === undefined) return '""';
    if (value === 'true' || value === 'false') return value;
    return JSON.stringify(value);
  });
}

/** Runs an already-substituted expression in a sandbox with nothing in scope. */
function runExpression(code: string): unknown {
  return new Script(`(${code})`).runInContext(createContext(Object.create(null)), {
    timeout: EVAL_TIMEOUT_MS,
  });
}

/**
 * Checks a condition without knowing runtime values, by substituting every
 * placeholder with `""` and evaluating that. Catches both malformed syntax and
 * the common mistake of leaving a comparand unquoted (`!= None` — an undefined
 * identifier), so a broken guard shows as an invalid script *before* it runs
 * rather than failing mid-chain once earlier steps have already touched the org.
 *
 * Only SyntaxError and ReferenceError are treated as authoring errors; anything
 * else can legitimately depend on the real values and is left to run time.
 *
 * @returns an error message, or null when the expression is usable.
 */
export function validateWhenExpression(expression: string): string | null {
  const raw = expression.trim();
  if (!raw) return null;

  try {
    runExpression(raw.replace(PLACEHOLDER, '""'));
  } catch (err) {
    // An error raised *inside* the sandbox belongs to that context's realm, so
    // `instanceof` against the host's constructors is always false — match on
    // the name instead.
    const { name, message } = err as Error;
    if (name === 'SyntaxError') {
      return `Invalid 'when' expression — ${message}. In: when: ${raw}`;
    }
    if (name === 'ReferenceError') {
      return (
        `Unknown name in 'when: ${raw}' — ${message}. ` +
        `Comparands must be quoted, e.g. \${cartType} !== "None".`
      );
    }
  }
  return null;
}

/**
 * The condition with its placeholders substituted — what was *actually*
 * compared. Logged alongside the original so a guard that fired the wrong way
 * shows its own reason: `${cartType} !== "None"` → `"" !== "None"` says at a
 * glance that the value never arrived.
 */
export function resolveWhenExpression(expression: string, vars: Record<string, string>): string {
  return toExpression(expression.trim(), vars);
}

/** An empty or missing condition means "always run". */
export function evaluateWhen(
  expression: string | undefined,
  vars: Record<string, string>,
): boolean {
  const raw = expression?.trim();
  if (!raw) return true;

  try {
    return Boolean(runExpression(toExpression(raw, vars)));
  } catch (err) {
    throw new Error(`Could not evaluate 'when: ${raw}' — ${(err as Error).message}`);
  }
}

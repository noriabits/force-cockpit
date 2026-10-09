// PURE: an Apex tab's label before de-duplication (see shared/view/tab-naming.ts).
//
// "The first identifier" read literally names almost every tab `System` — most
// snippets open with `System.debug(…)` — so the scan skips Apex keywords and the
// ubiquitous system types/namespaces and lands on the first name that actually
// says something: `UserInfo`, `Account`, `MyInvoiceService`. Comments and string
// literals are blanked first, so `// TODO fix Order` or `'Account'` never names
// a tab.

/** Base for a tab whose code names nothing — the strip numbers it `Apex (1)`, … */
export const DEFAULT_APEX_TAB_BASE = 'Apex';

/** Longest base kept; past it the label stops being a label. */
const MAX_BASE = 32;

/** Lowercased. Keywords, primitives, collections and the namespaces nearly every snippet uses. */
const SKIP = new Set([
  // keywords
  'abstract',
  'break',
  'catch',
  'class',
  'continue',
  'delete',
  'do',
  'else',
  'enum',
  'extends',
  'false',
  'final',
  'finally',
  'for',
  'global',
  'if',
  'implements',
  'insert',
  'instanceof',
  'interface',
  'merge',
  'new',
  'null',
  'override',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'this',
  'throw',
  'transient',
  'true',
  'try',
  'undelete',
  'update',
  'upsert',
  'virtual',
  'void',
  'while',
  'with',
  'without',
  'sharing',
  'inherited',
  // primitives, collections, very common system types
  'blob',
  'boolean',
  'date',
  'datetime',
  'decimal',
  'double',
  'id',
  'integer',
  'long',
  'object',
  'string',
  'time',
  'list',
  'set',
  'map',
  'sobject',
  // namespaces / statics nearly every snippet touches
  'system',
  'database',
  'schema',
  'limits',
  'json',
  'math',
  'test',
  'debug',
  'assert',
]);

/** Blank out comments and string literals, keeping offsets irrelevant (labels only). */
function stripNoise(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?(\*\/|$)/g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:\\.|[^'\\\n])*'?/g, ' ');
}

export function apexBaseName(code: string): string {
  const text = stripNoise(code ?? '');
  const identifiers = text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  const found = identifiers.find((word) => !SKIP.has(word.toLowerCase()));
  return found ? found.slice(0, MAX_BASE) : DEFAULT_APEX_TAB_BASE;
}

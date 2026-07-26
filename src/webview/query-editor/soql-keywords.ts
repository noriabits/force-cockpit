/**
 * The one SOQL vocabulary shared by the Quick Query editor's two consumers:
 * the cursor-context analyser used for autocomplete (autocomplete/soql-context.ts)
 * and the syntax tokenizer used for highlighting (highlight/soql-tokens.ts).
 * Keeping the clause list here means the two can never drift apart.
 * DOM-free and dependency-free.
 */

/**
 * Clause keywords, in the order they may appear. `key` is the canonical name the
 * context analyser reports (`GROUP BY` collapses to `GROUP`); `words` is the literal
 * source text, which may contain a space (matched with flexible whitespace).
 */
export const SOQL_CLAUSES: { key: string; words: string }[] = [
  { key: 'SELECT', words: 'SELECT' },
  { key: 'FROM', words: 'FROM' },
  { key: 'USING', words: 'USING SCOPE' },
  { key: 'WHERE', words: 'WHERE' },
  { key: 'WITH', words: 'WITH' },
  { key: 'GROUP', words: 'GROUP BY' },
  { key: 'HAVING', words: 'HAVING' },
  { key: 'ORDER', words: 'ORDER BY' },
  { key: 'LIMIT', words: 'LIMIT' },
  { key: 'OFFSET', words: 'OFFSET' },
  { key: 'FOR', words: 'FOR UPDATE' },
  { key: 'FOR', words: 'FOR VIEW' },
  { key: 'FOR', words: 'FOR REFERENCE' },
  { key: 'TYPEOF', words: 'TYPEOF' },
];

/** Keyword operators — the word-shaped ones; symbol operators are handled by the tokenizer. */
export const SOQL_OPERATOR_WORDS = [
  'AND',
  'OR',
  'NOT',
  'IN',
  'LIKE',
  'INCLUDES',
  'EXCLUDES',
  'ASC',
  'DESC',
  'NULLS',
  'FIRST',
  'LAST',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
];

/** Aggregate, date and formatting functions. */
export const SOQL_FUNCTIONS = [
  'COUNT',
  'COUNT_DISTINCT',
  'SUM',
  'AVG',
  'MIN',
  'MAX',
  'GROUPING',
  'FORMAT',
  'toLabel',
  'convertCurrency',
  'convertTimezone',
  'CALENDAR_MONTH',
  'CALENDAR_QUARTER',
  'CALENDAR_YEAR',
  'DAY_IN_MONTH',
  'DAY_IN_WEEK',
  'DAY_IN_YEAR',
  'DAY_ONLY',
  'FISCAL_MONTH',
  'FISCAL_QUARTER',
  'FISCAL_YEAR',
  'HOUR_IN_DAY',
  'WEEK_IN_MONTH',
  'WEEK_IN_YEAR',
  'DISTANCE',
  'GEOLOCATION',
];

/** Literal-valued words: booleans, NULL and the SOQL date literals. */
export const SOQL_LITERAL_WORDS = [
  'NULL',
  'TRUE',
  'FALSE',
  'YESTERDAY',
  'TODAY',
  'TOMORROW',
  'LAST_WEEK',
  'THIS_WEEK',
  'NEXT_WEEK',
  'LAST_MONTH',
  'THIS_MONTH',
  'NEXT_MONTH',
  'LAST_90_DAYS',
  'NEXT_90_DAYS',
  'LAST_N_DAYS',
  'NEXT_N_DAYS',
  'LAST_N_WEEKS',
  'NEXT_N_WEEKS',
  'LAST_N_MONTHS',
  'NEXT_N_MONTHS',
  'LAST_QUARTER',
  'THIS_QUARTER',
  'NEXT_QUARTER',
  'LAST_N_QUARTERS',
  'NEXT_N_QUARTERS',
  'LAST_YEAR',
  'THIS_YEAR',
  'NEXT_YEAR',
  'LAST_N_YEARS',
  'NEXT_N_YEARS',
  'LAST_FISCAL_QUARTER',
  'THIS_FISCAL_QUARTER',
  'NEXT_FISCAL_QUARTER',
  'LAST_FISCAL_YEAR',
  'THIS_FISCAL_YEAR',
  'NEXT_FISCAL_YEAR',
];

/**
 * Every single word that reads as a clause keyword (`GROUP BY` contributes both
 * `GROUP` and `BY`). The tokenizer scans word by word, so multi-word clauses are
 * coloured one word at a time.
 */
export const SOQL_CLAUSE_WORDS: string[] = Array.from(
  new Set(SOQL_CLAUSES.flatMap((c) => c.words.split(/\s+/))),
);

/**
 * Pure parser for the SOQL failure messages Salesforce returns. Extracts the
 * offending identifier so {@link SoqlDiagnosticsService} can go and find out what
 * is actually wrong with it. No I/O, no vscode — unit-tested directly.
 *
 * The messages this handles look like:
 *   No such column 'AssetReferenceId__c' on entity 'QuoteLineItem'. If you are ...
 *   Didn't understand relationship 'Accont' in field path. ...
 *   sObject type 'Acount' is not supported.
 *   INVALID_TYPE: ... Invalid type: Acount
 */

export type SoqlErrorInfo =
  | { kind: 'unknown-field'; field: string; entity: string; row?: number; column?: number }
  | { kind: 'unknown-relationship'; relationship: string; row?: number; column?: number }
  | { kind: 'unknown-object'; object: string; row?: number; column?: number };

const NO_SUCH_COLUMN = /No such column '([^']+)' on (?:entity|sobject) '([^']+)'/i;
const BAD_RELATIONSHIP = /Didn't understand relationship '([^']+)'/i;
const UNSUPPORTED_TYPE = /sObject type '([^']+)' is not supported/i;
const INVALID_TYPE = /\bInvalid type:\s*([A-Za-z0-9_.]+)/i;
const ROW_COLUMN = /ERROR at Row:(\d+):Column:(\d+)/i;

/** `ERROR at Row:1:Column:38`, when Salesforce included one. */
function positionOf(message: string): { row?: number; column?: number } {
  const m = ROW_COLUMN.exec(message);
  if (!m) return {};
  return { row: Number(m[1]), column: Number(m[2]) };
}

/**
 * @returns the structured cause, or null when the message is one we have nothing
 *   useful to add to (syntax errors, timeouts, malformed queries…).
 */
export function parseSoqlError(message: string): SoqlErrorInfo | null {
  if (!message) return null;
  const position = positionOf(message);

  const column = NO_SUCH_COLUMN.exec(message);
  if (column) {
    return { kind: 'unknown-field', field: column[1], entity: column[2], ...position };
  }

  const relationship = BAD_RELATIONSHIP.exec(message);
  if (relationship) {
    return { kind: 'unknown-relationship', relationship: relationship[1], ...position };
  }

  const unsupported = UNSUPPORTED_TYPE.exec(message);
  if (unsupported) {
    return { kind: 'unknown-object', object: unsupported[1], ...position };
  }

  const invalid = INVALID_TYPE.exec(message);
  if (invalid) {
    return { kind: 'unknown-object', object: invalid[1], ...position };
  }

  return null;
}

/**
 * The object named in the query's FROM clause. Needed for `unknown-relationship`,
 * whose message names the relationship but not the object it was resolved against.
 */
export function fromObjectOfQuery(soql: string): string | null {
  const m = /\bFROM\s+([A-Za-z0-9_]+)/i.exec(soql);
  return m ? m[1] : null;
}

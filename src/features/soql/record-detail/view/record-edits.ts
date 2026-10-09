// PURE, DOM-free — everything about turning a record's values into form input
// values and back. Unit-tested; the components only wire these to inputs.
//
// The model: an edit is the RAW input value (a string, or a boolean for a
// checkbox), stored per field. Comparison happens raw-to-raw against the
// original value's own raw form, never value-to-value. That is what keeps a
// datetime from reading as "changed" the moment it is shown: the input works in
// minutes and local time, Salesforce answers in milliseconds and UTC, and the
// round-trip is lossy — so an untouched field must never be converted back.
import type { RecordDetailField } from '../../../../shared/protocol';

export type RawValue = string | boolean;

type EditorKind =
  | 'readonly'
  | 'checkbox'
  | 'picklist'
  | 'number'
  | 'date'
  | 'datetime'
  | 'textarea'
  | 'text';

const NUMBER_TYPES = new Set(['int', 'double', 'currency', 'percent', 'long']);
/** Structured or binary values a single input cannot edit faithfully. */
const NEVER_EDITABLE = new Set(['address', 'location', 'base64', 'id', 'complexvalue']);

/** Which input a field gets — `readonly` unless the user may write it. */
export function editorKindFor(field: RecordDetailField): EditorKind {
  if (!field.updateable || field.calculated || NEVER_EDITABLE.has(field.type)) return 'readonly';
  if (field.type === 'boolean') return 'checkbox';
  if (field.type === 'picklist') return 'picklist';
  if (NUMBER_TYPES.has(field.type)) return 'number';
  if (field.type === 'date') return 'date';
  if (field.type === 'datetime') return 'datetime';
  if (field.type === 'textarea') return 'textarea';
  return 'text';
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A Salesforce datetime as a `datetime-local` value, in the viewer's own time zone. */
function toLocalDateTime(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** The original value as its input would hold it. */
export function toRawValue(field: RecordDetailField, value: unknown): RawValue {
  if (field.type === 'boolean') return value === true;
  if (value === null || value === undefined) return '';
  if (field.type === 'datetime' && typeof value === 'string') return toLocalDateTime(value);
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** What a value reads as in the table and the review diff. */
export function displayValue(field: RecordDetailField, value: unknown): string {
  if (field.type === 'boolean') return value === true ? 'true' : 'false';
  if (value === null || value === undefined) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/**
 * The value to PATCH for a raw input value. A cleared field is `null`, never
 * `''`: Salesforce stores `''` as-is on a text field and rejects it on a number
 * or date one, while `null` clears either.
 */
export function coerceRawValue(
  field: RecordDetailField,
  raw: RawValue,
): { value: unknown } | { error: string } {
  if (typeof raw === 'boolean') return { value: raw };
  if (raw.trim() === '') return { value: null };
  if (NUMBER_TYPES.has(field.type)) {
    const n = Number(raw.trim());
    return Number.isFinite(n)
      ? { value: n }
      : { error: `${field.label}: "${raw}" is not a number` };
  }
  if (field.type === 'datetime') {
    const d = new Date(raw);
    return Number.isNaN(d.getTime())
      ? { error: `${field.label}: "${raw}" is not a valid date and time` }
      : { value: d.toISOString() };
  }
  return { value: raw };
}

/** True when `raw` differs from what the field held when the record was loaded. */
export function isDirty(field: RecordDetailField, original: unknown, raw: RawValue): boolean {
  return raw !== toRawValue(field, original);
}

interface ReviewRow {
  name: string;
  label: string;
  before: string;
  after: string;
}

/**
 * The PATCH body (only fields that genuinely changed), a before → after row per
 * change for the review step, and every value that would not coerce. Edits for
 * fields the record no longer has, or may not write, are ignored.
 */
export function buildChanges(
  fields: RecordDetailField[],
  values: Record<string, unknown>,
  edits: Record<string, RawValue>,
): { changes: Record<string, unknown>; review: ReviewRow[]; errors: string[] } {
  const changes: Record<string, unknown> = {};
  const review: ReviewRow[] = [];
  const errors: string[] = [];
  for (const field of fields) {
    if (!(field.name in edits) || editorKindFor(field) === 'readonly') continue;
    const raw = edits[field.name];
    const original = values[field.name];
    if (!isDirty(field, original, raw)) continue;
    const coerced = coerceRawValue(field, raw);
    if ('error' in coerced) {
      errors.push(coerced.error);
      continue;
    }
    changes[field.name] = coerced.value;
    review.push({
      name: field.name,
      label: field.label,
      before: displayValue(field, original),
      after: displayValue(field, coerced.value),
    });
  }
  return { changes, review, errors };
}

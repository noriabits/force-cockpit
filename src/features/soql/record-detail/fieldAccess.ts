// PURE — telling "field-level security stops you" apart from "the field is
// read-only by nature", from data the host has already fetched.
import type { FieldDefinitionRow } from '../../../services/permissions/FieldAccessService';
import type { FieldAccessNote, HiddenField, RecordDetailField } from '../../../shared/protocol';

/**
 * Visible, writable by nature, but FLS grants no Edit.
 *
 * `permissionable` rules out what FLS never governs (audit/system fields, Id,
 * required fields); `calculated`/`autoNumber` rule out what nobody can write.
 * `!createable` is the subtle one: a field that is createable but not updateable
 * (set on insert, fixed after) is read-only by NATURE on an existing record —
 * whereas read-only FLS removes both, so only both-false points at FLS.
 */
export function isFlsReadOnly(field: RecordDetailField): boolean {
  return (
    !!field.permissionable &&
    !field.updateable &&
    !field.createable &&
    !field.calculated &&
    !field.autoNumber
  );
}

/**
 * Fields defined on the object (FieldDefinition, NOT FLS-filtered) that the
 * describe (FLS-filtered) left out — i.e. hidden from this user. `null`
 * definitions (lookup unavailable) means none can be claimed hidden.
 */
export function hiddenFieldsOf(
  definitions: FieldDefinitionRow[] | null,
  described: RecordDetailField[],
): HiddenField[] {
  if (!definitions) return [];
  const visible = new Set(described.map((f) => f.name.toLowerCase()));
  return definitions
    .filter((d) => !visible.has(d.QualifiedApiName.toLowerCase()))
    .map((d) => ({
      name: d.QualifiedApiName,
      label: d.Label || d.QualifiedApiName,
      type: d.DataType || '',
    }));
}

/** One note per restricted field, with who would grant the missing access. */
export function buildAccessNotes(
  readOnly: string[],
  hidden: string[],
  editGrants: Map<string, string[]> | null,
  readGrants: Map<string, string[]> | null,
): Record<string, FieldAccessNote> {
  const notes: Record<string, FieldAccessNote> = {};
  const grantedBy = (grants: Map<string, string[]> | null, name: string) =>
    grants ? (grants.get(name.toLowerCase()) ?? []) : null;
  for (const name of readOnly) {
    notes[name] = { kind: 'readOnly', grantedBy: grantedBy(editGrants, name) };
  }
  for (const name of hidden) {
    notes[name] = { kind: 'hidden', grantedBy: grantedBy(readGrants, name) };
  }
  return notes;
}

// PURE — the words for a field-level-security note (the 🔒 badge's tooltip and
// the header summary). Strings come from labels.js; this only assembles them.
import type { FieldAccessNote } from '../../../../shared/protocol';

type Labels = Record<string, string>;

/**
 * What the restriction is, then who would lift it. The three grant states read
 * differently on purpose: `[]` is a real answer ("nobody grants it"), `null`
 * means the lookup itself was unavailable — saying "nobody" there would send
 * the user chasing an admin over a gap in OUR visibility.
 */
export function accessTooltip(note: FieldAccessNote, L: Labels): string {
  const readOnly = note.kind === 'readOnly';
  const what = readOnly ? L.flsReadOnly : L.flsHidden;
  let who: string;
  if (note.grantedBy === null) who = L.grantsUnknown;
  else if (note.grantedBy.length === 0) who = readOnly ? L.grantsNoneEdit : L.grantsNoneRead;
  else {
    who = (readOnly ? L.grantsEdit : L.grantsRead).replace('{list}', note.grantedBy.join(', '));
  }
  return `${what} ${who}`;
}

/** "2 not editable · 1 hidden by field-level security", or '' when nothing is restricted. */
export function accessSummary(access: Record<string, FieldAccessNote>, L: Labels): string {
  const notes = Object.values(access);
  const readOnly = notes.filter((n) => n.kind === 'readOnly').length;
  const hidden = notes.length - readOnly;
  if (notes.length === 0) return '';
  const parts = [
    readOnly ? L.summaryReadOnly.replace('{n}', String(readOnly)) : '',
    hidden ? L.summaryHidden.replace('{n}', String(hidden)) : '',
  ].filter(Boolean);
  return `🔒 ${parts.join(' · ')} ${L.summarySuffix}`;
}

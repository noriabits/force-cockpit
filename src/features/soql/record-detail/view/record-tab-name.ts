// PURE, DOM-free helpers for the Record Detail's record tabs: what a tab is
// named after, whether two tabs hold the same record, and how many edits a tab
// has. Split out of the controller so each is testable on its own and the
// controller factory stays within the max-lines-per-function ratchet.
import { computeIdSuffix } from '../../../../utils/salesforce';
import type { RecordDetailData, RecordDetailField } from '../../../../shared/protocol';
import { isDirty, type RawValue } from './record-edits';

/** The parts of a record tab these helpers read. */
export interface NamedRecordTab {
  recordId: string;
  results?: RecordDetailData | null;
  /** The tab's current label, if it has one — see `recordBaseName`. */
  name?: string;
}

/**
 * The tab's label before the shared `tab-naming.ts` de-duplication.
 *
 * Once the record is loaded it is named after the object's name field — that is
 * what the user calls the record. Plenty of objects have none (CaseComment,
 * every junction object), so the fallback is the object's label plus the Id's
 * last six characters, which is short and still unique in practice.
 *
 * With nothing loaded the tab's OWN label comes first, which looks circular but
 * is what makes a restored tab keep the name it was saved under: the strip
 * re-derives every auto-named tab from its base as it loads them, and a record
 * tab's record is deliberately not fetched until the tab is activated — deriving
 * from the Id there would turn a restored `Acme` into `001…AAA` until it was
 * clicked. A tab with no label yet (brand new, or just handed a record Id) falls
 * through to the Id, and a blank one to the caller's own word for "nothing yet".
 */
export function recordBaseName(tab: NamedRecordTab, blankName: string): string {
  const rec = tab.results;
  if (rec) {
    const named = rec.fields.find((f) => f.nameField);
    const value = named ? rec.values[named.name] : null;
    if (typeof value === 'string' && value.trim()) return value.trim();
    return `${rec.objectLabel} ${rec.id.slice(-6)}`;
  }
  return (tab.name || '').trim() || tab.recordId.trim() || blankName;
}

/** The 18-char form of whatever was typed, or '' when it is neither 15 nor 18 chars. */
function canonicalId(raw: string): string {
  const id = (raw || '').trim();
  if (/^[a-zA-Z0-9]{15}$/.test(id)) return id + computeIdSuffix(id);
  if (/^[a-zA-Z0-9]{18}$/.test(id)) return id;
  return '';
}

/**
 * Whether two tabs' Ids name the same record. The 15-char form is normalised
 * first (`computeIdSuffix`), so the Id a user pasted from a Salesforce report is
 * recognised as the record a tab opened from SOQL results already holds. An
 * unrecognisable Id matches nothing, including another copy of itself — it is
 * not yet a record.
 */
export function sameRecordId(a: string, b: string): boolean {
  const left = canonicalId(a);
  return !!left && left === canonicalId(b);
}

/** How many of `edits` actually differ from the record on screen. */
export function dirtyCountOf(
  record: RecordDetailData | null,
  edits: Record<string, RawValue>,
): number {
  if (!record) return 0;
  return record.fields.filter(
    (f: RecordDetailField) => f.name in edits && isDirty(f, record.values[f.name], edits[f.name]),
  ).length;
}

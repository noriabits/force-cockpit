// PURE — turning whatever the user pasted into an 18-char Id and the sObject it
// belongs to. No describe call happens here; the caller hands in the global list.
import { computeIdSuffix, isSalesforceRecordId } from '../../../utils/salesforce';

/**
 * Trim and validate a pasted record Id; a 15-char Id gets its case-safe suffix.
 *
 * 15-char Ids are accepted here even though `isSalesforceRecordId` rejects them
 * for auto-linking: there a 15-char run in arbitrary text is too likely to be
 * something else, but a string the user deliberately pasted into an "Id" box is
 * an Id by intent — and it is the form Salesforce's own URLs and reports show.
 */
export function normalizeRecordId(raw: string): string {
  const id = raw.trim();
  if (/^[a-zA-Z0-9]{15}$/.test(id)) return id + computeIdSuffix(id);
  if (isSalesforceRecordId(id)) return id;
  throw new Error(`"${id}" is not a Salesforce record Id (expected 15 or 18 characters).`);
}

interface KeyPrefixed {
  name: string;
  label: string;
  keyPrefix: string | null;
}

/** The sObject whose `keyPrefix` matches the Id's first three characters. */
export function resolveObjectByKeyPrefix<T extends KeyPrefixed>(sobjects: T[], id: string): T {
  const prefix = id.slice(0, 3);
  const match = sobjects.find((s) => s.keyPrefix === prefix);
  if (!match) {
    throw new Error(
      `No object you can access has key prefix "${prefix}" — the record may be in another org, ` +
        'or your user cannot see its object.',
    );
  }
  return match;
}

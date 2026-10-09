// Fully-typed payloads for the Record Detail's two routes (SOQL tab →
// 🔎 Record Detail sub-tab). Typed end to end from day one, as a new feature
// should be; the rest of the protocol is migrated per feature (see
// `monitoring.ts`).
//
// Same hard constraint as `messages.ts`: no imports. The field shape is
// re-declared rather than imported from `services/describe/DescribeService.ts`
// because that module is host-only; the host's `DescribeField` is structurally
// assignable to `RecordDetailField`, so the compiler checks the two agree.

/** One field of the shown record's object, as Record Detail needs it. */
export interface RecordDetailField {
  name: string;
  label: string;
  type: string;
  referenceTo: string[];
  /** Active picklist values only. */
  picklistValues: string[];
  inlineHelpText: string | null;
  required: boolean;
  custom: boolean;
  unique: boolean;
  externalId: boolean;
  filterable: boolean;
  sortable: boolean;
  groupable: boolean;
  updateable?: boolean;
  calculated?: boolean;
  createable?: boolean;
  autoNumber?: boolean;
  permissionable?: boolean;
}

/**
 * Why the running user cannot fully use a field, when it is field-level security
 * (and not the field's own nature) that stops them.
 *   - `readOnly`: visible, writable by nature, but FLS grants no Edit.
 *   - `hidden`:   FLS grants no Read — the field is absent from the describe and
 *                 its value cannot be fetched.
 */
export interface FieldAccessNote {
  kind: 'readOnly' | 'hidden';
  /**
   * Permission sets / groups that would grant the missing access (Edit for
   * `readOnly`, Read for `hidden`). `[]` = none does; `null` = the lookup was
   * unavailable (it needs View Setup and Configuration).
   */
  grantedBy: string[] | null;
}

/** A field FLS hides from the user entirely, as FieldDefinition describes it. */
export interface HiddenField {
  name: string;
  label: string;
  /** FieldDefinition's DataType, e.g. `Text(255)` — not the describe type name. */
  type: string;
}

/** `recordDetailLoaded` / `recordChangesSaved` — one record and its schema. */
export interface RecordDetailData {
  objectName: string;
  objectLabel: string;
  /** Always the 18-char form, whatever was pasted. */
  id: string;
  fields: RecordDetailField[];
  /** Field API name → value as Salesforce returned it (`attributes` stripped). */
  values: Record<string, unknown>;
  /** Field API name → why FLS restricts it. Only restricted fields appear. */
  access: Record<string, FieldAccessNote>;
  /**
   * Fields the user cannot read at all. Empty when there are none OR when the
   * full field list was unavailable (no View Setup and Configuration).
   */
  hiddenFields: HiddenField[];
}

/** `loadRecordDetail` (webview → host). `recordId` may be 15 or 18 chars. */
export interface LoadRecordDetailMessage {
  type: 'loadRecordDetail';
  opId: string;
  recordId: string;
}

/** `saveRecordChanges` (webview → host) — ONLY the fields that changed. */
export interface SaveRecordChangesMessage {
  type: 'saveRecordChanges';
  opId: string;
  objectName: string;
  recordId: string;
  changes: Record<string, unknown>;
}

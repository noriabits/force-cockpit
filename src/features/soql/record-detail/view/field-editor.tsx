// The Value cell for one field: an input when the user may write the field, the
// value as text when not. Which input is decided by `editorKindFor`
// (record-edits.ts) — this file only renders it. Every input is controlled by
// the RAW edit value; coercion happens once, at review time.
import { isSalesforceRecordId } from '../../../../utils/salesforce';
import type { RecordDetailField } from '../../../../shared/protocol';
import { displayValue, editorKindFor, type RawValue } from './record-edits';

interface Props {
  field: RecordDetailField;
  original: unknown;
  raw: RawValue;
  onChange: (raw: RawValue) => void;
  /** Open the record a lookup points at. */
  onFollow: (id: string) => void;
}

/** A lookup's current value, followable when it is a real record Id. */
function FollowLink({ value, onFollow }: { value: unknown; onFollow: (id: string) => void }) {
  if (!isSalesforceRecordId(value)) return null;
  return (
    <a
      href="#"
      class="rec-detail-follow"
      onClick={(e) => {
        e.preventDefault();
        onFollow(value);
      }}
    >
      {value}
    </a>
  );
}

function PicklistInput({ field, raw, onChange }: Pick<Props, 'field' | 'raw' | 'onChange'>) {
  const current = String(raw);
  // An inactive value the record still holds must stay selectable, or showing
  // the record would silently look like it holds something else.
  const options =
    current && !field.picklistValues.includes(current)
      ? [current, ...field.picklistValues]
      : field.picklistValues;
  return (
    <select
      class="rec-detail-input"
      value={current}
      onChange={(e) => onChange(e.currentTarget.value)}
    >
      {!field.required && <option value="">--None--</option>}
      {options.map((v) => (
        <option key={v} value={v}>
          {v}
        </option>
      ))}
    </select>
  );
}

const INPUT_TYPE = { number: 'text', date: 'date', datetime: 'datetime-local', text: 'text' };

export function FieldValue({ field, original, raw, onChange, onFollow }: Props) {
  const kind = editorKindFor(field);
  const isLookup = field.type === 'reference';

  if (kind === 'readonly') {
    return isLookup && isSalesforceRecordId(original) ? (
      <FollowLink value={original} onFollow={onFollow} />
    ) : (
      <span class="rec-detail-readonly">{displayValue(field, original)}</span>
    );
  }
  if (kind === 'checkbox') {
    return (
      <input
        type="checkbox"
        class="rec-detail-checkbox"
        checked={raw === true}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
    );
  }
  if (kind === 'picklist') return <PicklistInput field={field} raw={raw} onChange={onChange} />;
  if (kind === 'textarea') {
    return (
      <textarea
        class="rec-detail-input rec-detail-textarea"
        rows={2}
        value={String(raw)}
        onInput={(e) => onChange(e.currentTarget.value)}
      />
    );
  }
  return (
    <span class="rec-detail-value-row">
      <input
        // Numbers stay a text input: type="number" silently reports '' for an
        // unparsable entry, which would read as "cleared" and PATCH a null.
        type={INPUT_TYPE[kind]}
        inputMode={kind === 'number' ? 'decimal' : undefined}
        class="rec-detail-input"
        value={String(raw)}
        onInput={(e) => onChange(e.currentTarget.value)}
      />
      {isLookup && <FollowLink value={original} onFollow={onFollow} />}
    </span>
  );
}

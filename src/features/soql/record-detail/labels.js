// User-facing strings for the SOQL tab's 🔎 Record Detail sub-tab.
window.RecordDetailLabels = {
  idPlaceholder: 'Record Id (15 or 18 characters)',
  show: 'Show',
  cancel: '✕ Cancel',
  cloneTab: '⧉ Clone',
  blankTabName: 'Record',
  newTabTooltip: 'New record tab',
  openInSalesforce: '↗ Open in Salesforce',
  filterPlaceholder: 'Filter fields by label, API name, type or value…',
  hint:
    'Paste a record Id to see every field you can read — including ones missing from the page ' +
    'layout — and edit the ones you can write. Or click 🔍 next to an Id in the Query results. ' +
    'Each record opens in its own tab, and your tabs come back next time you open this org.',
  oneChange: '1 unsaved change',
  manyChanges: '{n} unsaved changes',
  reviewChanges: 'Review changes',
  discard: 'Discard',
  reviewTitle: 'Save these changes?',
  confirmSaveBtn: 'Confirm save',
  backToEditing: 'Back to editing',
  confirmSave: 'Save {n} field change(s) to this record?',
  confirmDiscard: 'You have unsaved changes on this record. Discard them?',
  confirmCloseDirty: 'This tab has unsaved changes. Close it and discard them?',
  empty: '(empty)',
  // Compare
  compare: '⇄ Compare',
  compareOnlyOne: 'Open a second record of this object to compare.',
  compareReload: '↻ Reload',
  compareExit: '✕ Exit',
  onlyDifferences: 'Only differences',
  compareSummary: '{n} of {m} fields differ',
  compareNeedTwo: 'Pick at least two loaded records to compare.',
  compareCap: 'At most 4 records can be compared.',
  compareBaseline: 'Baseline — the other columns are highlighted where they differ from this one.',
  compareFocusTab: 'Leave Compare and open this record.',
  compareLoading: 'Loading…',
  compareFailed: 'Could not load: {message}',
  compareWrongObject: 'This is a {object}, not the object being compared.',
  compareFieldHeader: 'Field',
  confirmReloadDirty:
    'Some compared records have unsaved changes. Reload them and discard those changes?',
  saved: 'Saved.',
  errorNoId: 'Enter a record Id.',
  errorNotConnected: 'Not connected to any org.',
  errorUnknown: 'Something went wrong.',
  // Field-level security notes (🔒)
  flsReadOnlyBadge: '🔒 No edit access',
  flsHiddenBadge: '🔒 No read access',
  flsReadOnly: 'Field-level security makes this field read-only for you.',
  flsHidden: 'Field-level security hides this field from you, so its value cannot be read.',
  grantsEdit: 'Edit is granted by: {list}.',
  grantsRead: 'Read is granted by: {list}.',
  grantsNoneEdit:
    'No permission set or permission set group grants Edit on it — an admin will need to add it to one.',
  grantsNoneRead:
    'No permission set or permission set group grants Read on it — an admin will need to add it to one.',
  grantsUnknown:
    'Which permission sets would grant it could not be checked — that needs the ' +
    '"View Setup and Configuration" permission.',
  summaryReadOnly: '{n} not editable',
  summaryHidden: '{n} hidden',
  summarySuffix: 'by field-level security',
};

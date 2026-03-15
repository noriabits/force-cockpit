// Reactivate OmniScript — UI labels
// All user-facing strings for the Reactivate OmniScript feature.
// Loaded before view.js so window.ReactivateOmniscriptLabels is available when view.js runs.

window.ReactivateOmniscriptLabels = {
  // Buttons
  btnFetch: 'Fetch OmniScripts',
  btnReactivate: 'Reactivate',
  btnChange: 'Change',
  btnSelect: 'Select',

  // Description
  descFeature:
    'Fetch all active OmniScripts, filter by Type or SubType, then reactivate the selected one.',

  // Placeholders
  placeholderFilterType: 'Filter by Type...',
  placeholderFilterSubtype: 'Filter by SubType...',

  // Dynamic messages
  statusFetching: 'Fetching OmniScripts...',
  statusReactivating: 'Reactivating...',
  errorNotConnected: 'Not connected to any org.',
  errorNoResults: 'No active OmniScripts found.',
};

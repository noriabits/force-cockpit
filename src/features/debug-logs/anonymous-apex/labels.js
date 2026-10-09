// User-facing strings for the ▶️ Apex tab.
window.AnonymousApexLabels = {
  editorPlaceholder: 'System.debug(UserInfo.getUserName());\n\n// Cmd/Ctrl+Enter to execute.',
  execute: '▶ Execute',
  cancel: '✕ Cancel',
  clone: '⧉ Clone',
  cloneTooltip: 'Clone the current tab into a new tab',
  history: 'History ▾',
  save: '★ Save',
  saveTooltip: 'Save the current snippet',
  saveAsScript: '📜 Save as script',
  saveAsScriptTooltip: 'Open the Scripts tab’s new-script form, pre-filled with this snippet',
  presetLabel: 'Log level',
  presetTooltip:
    'Debug levels for this run’s log. They apply to this call only and override any active trace flag.',
  running: 'Executing…',
  success: '✓ Executed successfully',
  compileError: '✗ Compile error',
  exception: '✗ Uncaught exception',
  atPosition: (line, column) => (column ? `line ${line}, column ${column}` : `line ${line}`),
  goToLine: (line) => `Go to line ${line}`,
  noLog: 'No debug log was returned.',
  cancelled:
    'Cancelled. Apex cannot be stopped once sent — the transaction may still complete on the server.',
  emptyCode: 'Write some Apex to execute.',
  notConnected: 'Not connected to any org.',
  confirmExecute: 'Execute this anonymous Apex? It runs as you and can change data.',
  logTitle: '📄 Debug log',
};

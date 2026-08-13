// User-facing strings for the SOQL tab's AI query generator panel.
window.SoqlAiLabels = {
  openPanel: '✨ Ask AI',
  closePanel: '✨ Hide AI',
  send: 'Ask',
  newChat: 'New chat',
  modelAuto: 'Auto',
  noModels: 'No language model available. Enable GitHub Copilot to generate queries.',
  placeholder:
    'Describe the records you want, or ask about the query in the editor — ' +
    '"why doesn\'t this work?", "also filter by owner"',
  notConnected: 'Not connected to any org.',
  failed: 'Failed to generate a query',
  cancelledNote: '[cancelled — this turn was discarded from the conversation]',
  emptyOutputHint:
    'Describe the records you want in plain language, or ask about whatever is already in the ' +
    'editor — it is sent along as context. The assistant looks up your org’s schema, checks the ' +
    'query actually runs, and then offers it here.',
  proposalTitle: 'Proposed query',
  runQuery: '▶ Run query',
  copy: 'Copy',
  toolingNote: '⚠ Needs the Tooling API — the box is ticked for you when you run it.',
};

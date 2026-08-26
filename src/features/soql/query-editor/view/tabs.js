// @ts-check
import { createTabStrip } from '../../../shared/view/tab-strip';
import { baseNameFor as queryBaseName, isLegacyAutoName } from './tab-name';

// The SOQL half of the query tab bar: what a tab holds (query text + the
// Tooling toggle), how to read and write it from the shared editing surface, and
// what names it. Everything else — rendering, drag-to-reorder, rename, clone,
// close, per-tab run tracking, persistence — is the shared tab strip.

// Pre-fill new tabs so the user doesn't retype the boilerplate; the trailing
// "FROM " puts autocomplete straight into object-suggestion mode. Keep in sync
// with DEFAULT_QUERY in src/features/soql/query-editor/QueryStateStore.ts (separate bundle).
const DEFAULT_QUERY = 'SELECT Id FROM ';

/**
 * @typedef {Object} QueryTabsCtx
 * @property {HTMLElement} tabBarEl
 * @property {HTMLTextAreaElement} textarea
 * @property {HTMLInputElement} toolingCheckbox
 * @property {{ postMessage: (msg: any) => void }} vscode
 * @property {(tab: any) => void} onActivate  Render the activated tab's results (or clear).
 * @property {(tab: any) => void} onTabClosed Cancel the closed tab's run, if it had one.
 */

/** @param {QueryTabsCtx} ctx */
export function createQueryTabs(ctx) {
  const { tabBarEl, textarea, toolingCheckbox, vscode, onActivate, onTabClosed } = ctx;

  return createTabStrip({
    tabBarEl,
    vscode,
    persistType: 'saveQueryTabs',
    addTooltip: 'New query tab',
    newPayload: () => ({ query: DEFAULT_QUERY, useToolingApi: false }),
    payloadOf: (record) => ({
      query: record.query || '',
      useToolingApi: !!record.useToolingApi,
    }),
    readUI: () => ({ query: textarea.value, useToolingApi: toolingCheckbox.checked }),
    writeUI: (tab) => {
      textarea.value = tab.query;
      toolingCheckbox.checked = tab.useToolingApi;
      // Caret at the end so a default "SELECT Id FROM " lands ready for an object.
      const len = textarea.value.length;
      textarea.setSelectionRange(len, len);
    },
    baseNameFor: (tab) => queryBaseName(tab.query),
    isPristine: (tab) => {
      const query = (tab.query || '').trim();
      return query === '' || query === DEFAULT_QUERY.trim();
    },
    legacyAutoName: isLegacyAutoName,
    onActivate,
    onTabClosed,
  });
}

import type { Memento } from 'vscode';
import type { ApexSnippet, ApexState, ApexTab, SavedApexSnippet } from '../../../shared/protocol';
import { RECOMMENDED_PRESET_ID, findPreset } from '../explorer/debugLevelPresets';

const KEY_TABS = 'anonApex.tabs';
const KEY_ACTIVE = 'anonApex.activeTab';
const KEY_HISTORY = 'anonApex.history';
const KEY_SAVED = 'anonApex.savedSnippets';
const KEY_PRESET = 'anonApex.presetId';

const HISTORY_CAP = 50;
const SAVED_CAP = 50;

/** Placeholder name for the first tab; the webview re-derives it on load (`autoName`). */
const DEFAULT_TAB_NAME = 'Apex';

/**
 * Persists the ▶️ Apex tab's editor tabs, recent history, saved snippets and the
 * debug-level preset in workspaceState. Mirrors `QueryStateStore` /
 * `RestCallStateStore` rather than using `MementoStore`: the state spans several
 * keys and carries real domain logic (history dedup + cap, the tab clamp, an
 * unknown preset falling back). Pure logic over an injected `Memento`.
 */
export class ApexStateStore {
  constructor(private readonly memento: Memento) {}

  getState(): ApexState {
    const tabs = this.memento.get<ApexTab[]>(KEY_TABS, []);
    const activeTab = this.memento.get<number>(KEY_ACTIVE, 0);
    const presetId = this.memento.get<string>(KEY_PRESET, RECOMMENDED_PRESET_ID);
    return {
      tabs:
        tabs.length > 0
          ? tabs
          : [{ name: DEFAULT_TAB_NAME, code: '', autoName: true, nameObject: null }],
      activeTab: tabs.length > 0 && activeTab >= 0 && activeTab < tabs.length ? activeTab : 0,
      history: this.memento.get<ApexSnippet[]>(KEY_HISTORY, []),
      savedSnippets: this.memento.get<SavedApexSnippet[]>(KEY_SAVED, []),
      // A preset removed in a later release must not leave the picker on nothing.
      presetId: findPreset(presetId) ? presetId : RECOMMENDED_PRESET_ID,
    };
  }

  async saveTabs(tabs: ApexTab[], activeTab: number): Promise<void> {
    await this.memento.update(KEY_TABS, tabs);
    await this.memento.update(KEY_ACTIVE, activeTab);
  }

  async savePreset(presetId: string): Promise<void> {
    if (findPreset(presetId)) await this.memento.update(KEY_PRESET, presetId);
  }

  /**
   * Unshift the snippet as it ran, dedup by its trimmed code, cap to HISTORY_CAP.
   * Returns the new list. Stored trimmed, so a re-run of the same snippet with
   * different leading or trailing blank lines is one entry, not two.
   */
  async addHistory(entry: ApexSnippet): Promise<ApexSnippet[]> {
    const code = (entry.code ?? '').trim();
    if (!code) return this.memento.get<ApexSnippet[]>(KEY_HISTORY, []);
    const existing = this.memento.get<ApexSnippet[]>(KEY_HISTORY, []);
    const next = [{ code }, ...existing.filter((e) => e.code !== code)].slice(0, HISTORY_CAP);
    await this.memento.update(KEY_HISTORY, next);
    return next;
  }

  /** Replace the saved-snippet list (cap to SAVED_CAP). Returns the stored list. */
  async saveSavedSnippets(list: SavedApexSnippet[]): Promise<SavedApexSnippet[]> {
    const next = (Array.isArray(list) ? list : []).slice(0, SAVED_CAP);
    await this.memento.update(KEY_SAVED, next);
    return next;
  }
}

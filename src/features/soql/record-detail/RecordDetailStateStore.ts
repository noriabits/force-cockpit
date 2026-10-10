import type { Memento } from 'vscode';
import type { RecordDetailState, RecordDetailTab } from '../../../shared/protocol';

/** One workspaceState key holding every org's tabs, keyed by orgId. */
const KEY_TABS_BY_ORG = 'recordDetail.tabsByOrg';

/** Record tabs kept per org. Enough to hold a working set, not a session history. */
const TABS_CAP = 20;

type StoredEntry = { tabs: RecordDetailTab[]; activeTab: number };
type StoredByOrg = Record<string, StoredEntry>;

/**
 * Persists the Record Detail's record tabs, **per org**.
 *
 * Per org because a tab holds a record Id, which means nothing in another org:
 * restoring a sandbox's tabs against production would load either the wrong
 * record or none. Mirrors `QueryStateStore` / `ApexStateStore` (pure logic over
 * an injected `Memento`) rather than `MementoStore` — the per-org map carries
 * real domain logic: the cap, the activeTab clamp, and refusing a save that does
 * not say which org it belongs to.
 */
export class RecordDetailStateStore {
  constructor(private readonly memento: Memento) {}

  /**
   * The tabs stored for `orgId`. An unknown org (or none connected) returns no
   * tabs, which the webview renders as one blank tab.
   */
  getState(orgId: string | null): RecordDetailState {
    const entry = orgId ? this.byOrg()[orgId] : undefined;
    const tabs = sanitizeTabs(entry?.tabs);
    return { orgId, tabs, activeTab: clampActive(entry?.activeTab, tabs.length) };
  }

  /**
   * Store `tabs` under `orgId`. A save with no orgId is **ignored**: the webview
   * stamps one only once it knows whose tabs it is holding, so a persist racing
   * an org switch is dropped rather than written under the wrong org.
   */
  async saveTabs(
    orgId: string | null | undefined,
    tabs: RecordDetailTab[],
    activeTab: number,
  ): Promise<void> {
    if (!orgId) return;
    const clean = sanitizeTabs(tabs).slice(0, TABS_CAP);
    const next: StoredByOrg = {
      ...this.byOrg(),
      [orgId]: { tabs: clean, activeTab: clampActive(activeTab, clean.length) },
    };
    await this.memento.update(KEY_TABS_BY_ORG, next);
  }

  private byOrg(): StoredByOrg {
    const stored = this.memento.get<StoredByOrg>(KEY_TABS_BY_ORG, {});
    return stored && typeof stored === 'object' ? stored : {};
  }
}

/** Keep only entries that are shaped like a tab — the value crosses postMessage. */
function sanitizeTabs(tabs: unknown): RecordDetailTab[] {
  if (!Array.isArray(tabs)) return [];
  return tabs
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
    .map((t) => ({
      recordId: typeof t.recordId === 'string' ? t.recordId : '',
      name: typeof t.name === 'string' ? t.name : '',
      autoName: t.autoName !== false,
      nameObject: typeof t.nameObject === 'string' ? t.nameObject : null,
    }))
    .slice(0, TABS_CAP);
}

function clampActive(activeTab: unknown, length: number): number {
  if (typeof activeTab !== 'number' || activeTab < 0 || activeTab >= length) return 0;
  return activeTab;
}

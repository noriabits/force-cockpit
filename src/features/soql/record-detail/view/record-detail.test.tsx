// @vitest-environment jsdom
// The Record Detail bundle, driven through its real seams only: the DOM,
// `__onMessage` replies, the `__registerFeature` org edges and the
// `__showRecordDetail` global. Selectors are class/text based. Interactions are
// wrapped in act() because Preact batches signal-driven re-renders into a
// microtask (see the same note in rest-flow.test.tsx).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup } from '@testing-library/preact';
import type { RecordDetailField, RecordDetailData } from '../../../../shared/protocol';
// Sets window.RecordDetailLabels, exactly as its <script defer> tag does in the panel.
import '../labels.js';

type Post = Record<string, any>;
const w = window as unknown as Record<string, any>;

let posts: Post[];
let inbound: Map<string, (msg: any) => void>;
let featureHandlers: Record<string, Record<string, () => void>>;
/** Stashed rather than invoked: the real sensitive-org confirm is an async modal. */
let pendingConfirms: Array<() => void>;
let activated: string[];
/** What __setTooltip was handed, by element — the FLS reason lives only there. */
let tooltips: Map<Element, string>;

function installGlobals() {
  posts = [];
  inbound = new Map();
  featureHandlers = {};
  pendingConfirms = [];
  activated = [];
  w.__vscode = { postMessage: (msg: Post) => posts.push(msg) };
  tooltips = new Map();
  w.__setTooltip = (el: Element, text: string) => tooltips.set(el, text);
  w.__onMessage = (type: string, handler: (msg: any) => void) => inbound.set(type, handler);
  w.__registerFeature = (id: string, handlers: Record<string, () => void>) => {
    featureHandlers[id] = Object.fromEntries(
      Object.entries(handlers).map(([name, fn]) => [name, () => act(() => fn())]),
    );
  };
  w.__orgConnected = true;
  w.__currentOrg = { orgId: ORG_ID, sandboxName: null, isProtectedOrg: true };
  w.__confirmIfSensitive = (_org: unknown, _label: string, onConfirmed: () => void) => {
    pendingConfirms.push(onConfirmed);
  };
  w.__confirmAction = (_prompt: string, onConfirmed: () => void) => onConfirmed();
  w.__activateTab = (id: string) => activated.push(`tab:${id}`);
  w.__activateSubTab = (bar: string, id: string) => activated.push(`${bar}:${id}`);
}

async function mount() {
  document.body.innerHTML = '<div id="record-detail-root"></div>';
  vi.resetModules();
  await import('./index');
}

// ── Fixture ──────────────────────────────────────────────────────────────────
const ACCOUNT_ID = '001000000000001AAA';
const ACCOUNT_ID_15 = '001000000000001';
const OTHER_ID = '001000000000002AAB';
const USER_ID = '005000000000001AAA';
const ORG_ID = '00D000000000001EAA';

function field(
  name: string,
  type: string,
  extra: Partial<RecordDetailField> = {},
): RecordDetailField {
  return {
    name,
    label: name,
    type,
    referenceTo: [],
    picklistValues: [],
    inlineHelpText: null,
    required: false,
    custom: false,
    unique: false,
    externalId: false,
    filterable: true,
    sortable: true,
    groupable: true,
    updateable: true,
    calculated: false,
    ...extra,
  };
}

function account(
  values: Record<string, unknown> = {},
  extra: Partial<RecordDetailData> = {},
): RecordDetailData {
  return {
    access: {},
    hiddenFields: [],
    ...extra,
    objectName: 'Account',
    objectLabel: 'Account',
    id: ACCOUNT_ID,
    fields: [
      field('Id', 'id', { updateable: false }),
      field('Name', 'string', { nameField: true }),
      field('Industry', 'picklist', { picklistValues: ['Tech', 'Retail'] }),
      field('AnnualRevenue', 'currency'),
      field('OwnerId', 'reference', { updateable: false, referenceTo: ['User'] }),
    ],
    values: {
      Id: ACCOUNT_ID,
      Name: 'Acme',
      Industry: 'Tech',
      AnnualRevenue: 100,
      OwnerId: USER_ID,
      ...values,
    },
  };
}

/** A second Account, for the second tab. */
function globex(): RecordDetailData {
  return { ...account({ Name: 'Globex' }), id: OTHER_ID };
}

/** A record of another object with no name field — the Id-tail tab name. */
function user(): RecordDetailData {
  return {
    objectName: 'User',
    objectLabel: 'User',
    id: USER_ID,
    fields: [field('Id', 'id', { updateable: false })],
    values: { Id: USER_ID },
    access: {},
    hiddenFields: [],
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const $ = <T extends Element>(sel: string) => document.querySelector(sel) as T;
const $$ = (sel: string) => Array.from(document.querySelectorAll(sel));
const postsOf = (type: string) => posts.filter((p) => p.type === type);
const lastPost = (type: string) => {
  const all = postsOf(type);
  return all[all.length - 1];
};

function btnByText(text: string): HTMLButtonElement {
  const found = $$('button').find((b) => (b.textContent || '').trim().startsWith(text));
  if (!found) throw new Error(`No button starting with "${text}"`);
  return found as HTMLButtonElement;
}

function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  act(() => {
    el.value = value;
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function deliver(type: string, data: unknown) {
  const handler = inbound.get(type);
  if (!handler) throw new Error(`No handler registered for "${type}"`);
  act(() => handler({ type, data }));
}

/** The table row whose API-name cell reads `name`. */
function row(name: string): HTMLTableRowElement {
  const cell = $$('.rec-detail-name').find((td) => td.textContent === name);
  if (!cell) throw new Error(`No row for ${name}`);
  return cell.closest('tr') as HTMLTableRowElement;
}

/** Type an Id, press Show, and answer with `rec`. */
function loadRecord(rec: RecordDetailData, typed = rec.id) {
  setValue($<HTMLInputElement>('.rec-detail-id-input'), typed);
  click(btnByText('Show'));
  const { opId } = lastPost('loadRecordDetail');
  deliver('recordDetailLoaded', { ...rec, opId });
}

/** Tab labels, without the ` ⋯` the strip appends to a running tab. */
const tabNames = () =>
  $$('.query-tab-label').map((el) => (el.textContent || '').replace(/ ⋯$/, '').trim());
const activeTabName = () =>
  ($('.query-tab--active .query-tab-label')?.textContent || '').replace(/ ⋯$/, '').trim();

function clickTab(name: string) {
  const label = $$('.query-tab-label').find(
    (el) => (el.textContent || '').replace(/ ⋯$/, '').trim() === name,
  );
  if (!label) throw new Error(`No tab named "${name}" (have: ${tabNames().join(', ')})`);
  click(label);
}

/** The reply to the initial/hydration `loadRecordDetailState`, for this org by default. */
function deliverState(
  tabs: Array<{ recordId: string; name: string }>,
  activeTab = 0,
  orgId: string | null = ORG_ID,
) {
  deliver('recordDetailStateLoaded', {
    orgId,
    activeTab,
    tabs: tabs.map((t) => ({ ...t, autoName: true, nameObject: null })),
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────
describe('Record Detail', () => {
  beforeEach(async () => {
    installGlobals();
    await mount();
  });
  afterEach(cleanup);

  describe('loading', () => {
    it('posts the typed Id, counts as busy, and renders every field once answered', () => {
      setValue($<HTMLInputElement>('.rec-detail-id-input'), ' 001000000000001 ');
      click(btnByText('Show'));

      const req = lastPost('loadRecordDetail');
      expect(req.recordId).toBe('001000000000001');
      expect(req.opId).toMatch(/^detail-\d+$/);
      expect(postsOf('operationStarted')).toEqual([{ type: 'operationStarted', opId: req.opId }]);

      deliver('recordDetailLoaded', { ...account(), opId: req.opId });

      expect(postsOf('operationEnded')).toEqual([{ type: 'operationEnded', opId: req.opId }]);
      expect($('.rec-detail-title').textContent).toContain('Account');
      expect($('.rec-detail-id').textContent).toBe(ACCOUNT_ID);
      // Sorted by API name.
      expect($$('.rec-detail-name').map((c) => c.textContent)).toEqual([
        'AnnualRevenue',
        'Id',
        'Industry',
        'Name',
        'OwnerId',
      ]);
      // A writable field gets an input, a read-only one plain text.
      expect(row('Name').querySelector('input')?.value).toBe('Acme');
      expect(row('Id').querySelector('input')).toBeNull();
    });

    it('shows a Salesforce error verbatim', () => {
      setValue($<HTMLInputElement>('.rec-detail-id-input'), ACCOUNT_ID);
      click(btnByText('Show'));
      const { opId } = lastPost('loadRecordDetail');
      deliver('loadRecordDetailError', { opId, message: '404 Not Found — NOT_FOUND: gone' });

      expect($('.rec-detail-error').textContent).toBe('404 Not Found — NOT_FOUND: gone');
    });

    it('drops a reply for a load that was cancelled, but still ends its operation', () => {
      setValue($<HTMLInputElement>('.rec-detail-id-input'), ACCOUNT_ID);
      click(btnByText('Show'));
      const { opId } = lastPost('loadRecordDetail');
      click(btnByText('✕ Cancel'));

      expect(lastPost('cancelOperation')).toEqual({ type: 'cancelOperation', opId });
      deliver('recordDetailLoaded', { ...account(), opId });
      expect($('.rec-detail-title')).toBeNull();
    });

    it('reuses the blank tab after a failed attempt, instead of leaving it behind', () => {
      click(btnByText('Show'));
      expect($('.rec-detail-error').textContent).toBe('Enter a record Id.');

      // Typing drops the stale message, so the tab is blank again and is reused.
      loadRecord(account());
      expect(tabNames()).toEqual(['Acme']);
      expect($('.rec-detail-error')).toBeNull();
    });

    it('refuses to load while disconnected', () => {
      w.__orgConnected = false;
      setValue($<HTMLInputElement>('.rec-detail-id-input'), ACCOUNT_ID);
      click(btnByText('Show'));

      expect(postsOf('loadRecordDetail')).toEqual([]);
      expect($('.rec-detail-error').textContent).toBe('Not connected to any org.');
    });
  });

  describe('browsing', () => {
    it('filters by label, API name, type or value, with an X of Y counter', () => {
      loadRecord(account());
      setValue($<HTMLInputElement>('.rec-detail-filter'), 'acme');

      expect($$('.rec-detail-name').map((c) => c.textContent)).toEqual(['Name']);
      expect($('.rec-detail-count').textContent).toBe('1 of 5');
    });

    it('follows a lookup into its own focused tab, leaving the first one loaded', () => {
      loadRecord(account());
      click(row('OwnerId').querySelector('.rec-detail-follow') as Element);

      const follow = lastPost('loadRecordDetail');
      expect(follow.recordId).toBe(USER_ID);
      deliver('recordDetailLoaded', { ...user(), opId: follow.opId });

      expect($('.rec-detail-id').textContent).toBe(USER_ID);
      expect(tabNames()).toEqual(['Acme', 'User 001AAA']);
      expect(activeTabName()).toBe('User 001AAA');

      // The record we came from is still a tab — no reload to go back to it.
      const before = postsOf('loadRecordDetail').length;
      clickTab('Acme');
      expect($('.rec-detail-id').textContent).toBe(ACCOUNT_ID);
      expect(postsOf('loadRecordDetail')).toHaveLength(before);
    });

    it('opens the record in Salesforce on request', () => {
      loadRecord(account());
      click(btnByText('↗ Open in Salesforce'));
      expect(lastPost('openRecord')).toEqual({ type: 'openRecord', recordId: ACCOUNT_ID });
    });
  });

  describe('editing and saving', () => {
    it('reviews a diff, waits for the sensitive-org confirm, then PATCHes only what changed', () => {
      loadRecord(account());
      setValue(row('Name').querySelector('input') as HTMLInputElement, 'Acme Corp');
      setValue(row('AnnualRevenue').querySelector('input') as HTMLInputElement, '');
      setValue(row('Industry').querySelector('select') as HTMLSelectElement, 'Tech'); // unchanged

      expect($('.rec-detail-dirty-count').textContent).toBe('2 unsaved changes');
      click(btnByText('Review changes'));
      expect($$('.rec-detail-review tbody tr').map((tr) => tr.textContent)).toEqual([
        'Name (Name)AcmeAcme Corp',
        'AnnualRevenue (AnnualRevenue)100(empty)',
      ]);

      click(btnByText('Confirm save'));
      // Nothing is sent until the (asynchronous) sensitive-org modal is answered.
      expect(postsOf('saveRecordChanges')).toEqual([]);
      expect(pendingConfirms).toHaveLength(1);

      act(() => pendingConfirms[0]());
      const save = lastPost('saveRecordChanges');
      expect(save).toMatchObject({
        objectName: 'Account',
        recordId: ACCOUNT_ID,
        changes: { Name: 'Acme Corp', AnnualRevenue: null },
      });

      deliver('recordChangesSaved', {
        ...account({ Name: 'Acme Corp', AnnualRevenue: null }),
        opId: save.opId,
      });
      expect($('.rec-detail-notice').textContent).toBe('Saved.');
      expect($('.rec-detail-dirty-count')).toBeNull();
      expect(row('Name').querySelector('input')?.value).toBe('Acme Corp');
    });

    it('sends nothing when the sensitive-org confirm is declined', () => {
      loadRecord(account());
      setValue(row('Name').querySelector('input') as HTMLInputElement, 'Acme Corp');
      click(btnByText('Review changes'));
      click(btnByText('Confirm save'));

      expect(postsOf('saveRecordChanges')).toEqual([]);
    });

    it('rejects a value that is not a number before anything is sent', () => {
      loadRecord(account());
      setValue(row('AnnualRevenue').querySelector('input') as HTMLInputElement, 'lots');
      click(btnByText('Review changes'));

      expect($('.rec-detail-error').textContent).toBe('AnnualRevenue: "lots" is not a number');
      expect($('.rec-detail-review')).toBeNull();
    });

    it('keeps the edits and shows Salesforce’s message when the save fails', () => {
      loadRecord(account());
      setValue(row('Name').querySelector('input') as HTMLInputElement, 'A');
      click(btnByText('Review changes'));
      click(btnByText('Confirm save'));
      act(() => pendingConfirms[0]());
      const { opId } = lastPost('saveRecordChanges');

      deliver('saveRecordChangesError', {
        opId,
        message: '400 Bad Request — FIELD_CUSTOM_VALIDATION_EXCEPTION: Name is too short',
      });
      expect($('.rec-detail-error').textContent).toContain('Name is too short');
      expect(row('Name').querySelector('input')?.value).toBe('A');
      expect($('.rec-detail-dirty-count').textContent).toBe('1 unsaved change');
    });

    it('opens another record without asking — unsaved edits stay in their own tab', () => {
      let asked = 0;
      w.__confirmAction = () => {
        asked++;
      };
      loadRecord(account());
      setValue(row('Name').querySelector('input') as HTMLInputElement, 'Changed');
      click(row('OwnerId').querySelector('.rec-detail-follow') as Element);
      deliver('recordDetailLoaded', { ...user(), opId: lastPost('loadRecordDetail').opId });

      expect(asked).toBe(0);
      clickTab('Acme');
      expect(row('Name').querySelector('input')?.value).toBe('Changed');
    });

    it('asks before re-loading the record on screen over unsaved edits', () => {
      let asked = 0;
      w.__confirmAction = () => {
        asked++; // declined
      };
      loadRecord(account());
      setValue(row('Name').querySelector('input') as HTMLInputElement, 'Changed');
      const before = postsOf('loadRecordDetail').length;
      click(btnByText('Show'));

      expect(asked).toBe(1);
      expect(postsOf('loadRecordDetail')).toHaveLength(before);
      expect(row('Name').querySelector('input')?.value).toBe('Changed');
    });
  });

  describe('field-level security', () => {
    const restricted = () =>
      account(
        {},
        {
          access: {
            Industry: { kind: 'readOnly', grantedBy: ['Sales_Ops (Permission Set)'] },
            Secret__c: { kind: 'hidden', grantedBy: null },
          },
          hiddenFields: [{ name: 'Secret__c', label: 'Secret', type: 'Text(80)' }],
        },
      );

    it('marks a field FLS makes read-only, and says who would grant Edit', () => {
      loadRecord(restricted());
      const badge = row('Industry').querySelector('.rec-detail-fls-badge') as HTMLElement;

      expect(row('Industry').classList.contains('rec-detail-tr--fls-readonly')).toBe(true);
      expect(badge.textContent).toBe('🔒 No edit access');
      expect(tooltips.get(badge)).toBe(
        'Field-level security makes this field read-only for you. ' +
          'Edit is granted by: Sales_Ops (Permission Set).',
      );
      expect(badge.hasAttribute('data-tooltip-wrap')).toBe(true);
      // An unrestricted field carries no badge.
      expect(row('Name').querySelector('.rec-detail-fls-badge')).toBeNull();
    });

    it('lists a hidden field in name order, with no value and no flags', () => {
      loadRecord(restricted());
      const hidden = row('Secret__c');

      expect($$('.rec-detail-name').map((c) => c.textContent)).toContain('Secret__c');
      expect(hidden.classList.contains('rec-detail-tr--fls-hidden')).toBe(true);
      expect(hidden.querySelector('input, select')).toBeNull();
      expect(hidden.querySelector('.rec-detail-fls-badge')?.textContent).toBe('🔒 No read access');
      expect(tooltips.get(hidden.querySelector('.rec-detail-fls-badge') as Element)).toContain(
        'could not be checked',
      );
      expect($('.rec-detail-count').textContent).toBe('6 of 6');
    });

    it('summarises the restrictions next to the record header', () => {
      loadRecord(restricted());
      expect($('.rec-detail-fls-summary').textContent).toBe(
        '🔒 1 not editable · 1 hidden by field-level security',
      );
    });

    it('shows no summary when nothing is restricted', () => {
      loadRecord(account());
      expect($('.rec-detail-fls-summary')).toBeNull();
    });
  });

  describe('record tabs', () => {
    it('clears the record on screen the moment another is requested from 🔍', () => {
      loadRecord(account());
      act(() => w.__showRecordDetail(OTHER_ID));

      // Before the reply: nothing of the previous record shows in the new tab.
      expect($('.rec-detail-title')).toBeNull();
      expect($('.rec-detail-id')).toBeNull();
      expect($$('.rec-detail-name')).toEqual([]);

      const { opId } = lastPost('loadRecordDetail');
      deliver('recordDetailLoaded', { ...globex(), opId });
      expect($('.rec-detail-id').textContent).toBe(OTHER_ID);
    });

    it('focuses the tab that already holds a record instead of opening a second one', () => {
      loadRecord(account());
      click(row('OwnerId').querySelector('.rec-detail-follow') as Element);
      deliver('recordDetailLoaded', { ...user(), opId: lastPost('loadRecordDetail').opId });
      expect(tabNames()).toEqual(['Acme', 'User 001AAA']);

      // The 15-char form of a record a tab already holds is the same record.
      act(() => w.__showRecordDetail(ACCOUNT_ID_15));

      expect(tabNames()).toEqual(['Acme', 'User 001AAA']);
      expect(activeTabName()).toBe('Acme');
      // Focused and re-fetched, never duplicated.
      expect(lastPost('loadRecordDetail').recordId).toBe(ACCOUNT_ID);
    });

    it('reuses a blank tab, then opens each later record in its own tab', () => {
      expect(tabNames()).toEqual(['Record']);
      loadRecord(account());
      expect(tabNames()).toEqual(['Acme']);

      act(() => w.__showRecordDetail(OTHER_ID));
      deliver('recordDetailLoaded', { ...globex(), opId: lastPost('loadRecordDetail').opId });
      expect(tabNames()).toEqual(['Acme', 'Globex']);
    });

    it('lands a background tab’s load in that tab, not the one on screen', () => {
      loadRecord(account());
      act(() => w.__showRecordDetail(OTHER_ID));
      const pending = lastPost('loadRecordDetail');
      // Back to the first tab while the second is still loading.
      clickTab('Acme');
      expect($('.rec-detail-id').textContent).toBe(ACCOUNT_ID);

      deliver('recordDetailLoaded', { ...globex(), opId: pending.opId });

      // The visible record is untouched; the background tab took the reply.
      expect($('.rec-detail-id').textContent).toBe(ACCOUNT_ID);
      expect(tabNames()).toEqual(['Acme', 'Globex']);
      clickTab('Globex');
      expect($('.rec-detail-id').textContent).toBe(OTHER_ID);
    });

    it('marks a tab still loading in the background', () => {
      loadRecord(account());
      act(() => w.__showRecordDetail(OTHER_ID));
      clickTab('Acme');

      expect($$('.query-tab-label').map((el) => el.textContent)).toEqual(['Acme', `${OTHER_ID} ⋯`]);
    });

    it('keeps each tab’s own edits and filter across a switch', () => {
      loadRecord(account());
      setValue(row('Name').querySelector('input') as HTMLInputElement, 'Acme Corp');
      setValue($<HTMLInputElement>('.rec-detail-filter'), 'owner');

      act(() => w.__showRecordDetail(OTHER_ID));
      deliver('recordDetailLoaded', { ...globex(), opId: lastPost('loadRecordDetail').opId });
      expect($('.rec-detail-dirty-count')).toBeNull();
      expect($<HTMLInputElement>('.rec-detail-filter').value).toBe('');

      clickTab('Acme');
      expect($('.rec-detail-dirty-count').textContent).toBe('1 unsaved change');
      // The filter is this tab's too, so only the matching row is on screen.
      expect($<HTMLInputElement>('.rec-detail-filter').value).toBe('owner');
      expect($$('.rec-detail-name').map((c) => c.textContent)).toEqual(['OwnerId']);

      setValue($<HTMLInputElement>('.rec-detail-filter'), '');
      expect(row('Name').querySelector('input')?.value).toBe('Acme Corp');
    });

    it('asks before closing a tab with unsaved edits, and keeps it when declined', () => {
      const asks: string[] = [];
      w.__confirmAction = (prompt: string) => {
        asks.push(prompt); // declined
      };
      loadRecord(account());
      act(() => w.__showRecordDetail(OTHER_ID));
      deliver('recordDetailLoaded', { ...globex(), opId: lastPost('loadRecordDetail').opId });
      setValue(row('Name').querySelector('input') as HTMLInputElement, 'Globex Inc');

      click($$('.query-tab--active .query-tab-close')[0]);
      // Its own wording — closing discards the tab, not just the edits.
      expect(asks).toEqual(['This tab has unsaved changes. Close it and discard them?']);
      expect(tabNames()).toEqual(['Acme', 'Globex']);

      // Accepted this time.
      w.__confirmAction = (_p: string, ok: () => void) => ok();
      click($$('.query-tab--active .query-tab-close')[0]);
      expect(tabNames()).toEqual(['Acme']);
    });

    it('closes a clean tab with no question asked', () => {
      let asked = 0;
      w.__confirmAction = () => {
        asked++;
      };
      loadRecord(account());
      act(() => w.__showRecordDetail(OTHER_ID));
      deliver('recordDetailLoaded', { ...globex(), opId: lastPost('loadRecordDetail').opId });

      click($$('.query-tab--active .query-tab-close')[0]);
      expect(asked).toBe(0);
      expect(tabNames()).toEqual(['Acme']);
    });

    it('names a tab after the record, falling back to the object and Id tail', () => {
      loadRecord(account());
      expect(tabNames()).toEqual(['Acme']);

      act(() => w.__showRecordDetail(USER_ID));
      deliver('recordDetailLoaded', { ...user(), opId: lastPost('loadRecordDetail').opId });
      // User has no name field in this fixture.
      expect(tabNames()).toEqual(['Acme', 'User 001AAA']);
    });

    it('keeps a saved record visible while the PATCH is in flight, and renames the tab', () => {
      loadRecord(account());
      setValue(row('Name').querySelector('input') as HTMLInputElement, 'Acme Corp');
      click(btnByText('Review changes'));
      click(btnByText('Confirm save'));
      act(() => pendingConfirms[0]());

      // Unlike a load, a save does not blank the record it is saving.
      expect($('.rec-detail-id').textContent).toBe(ACCOUNT_ID);

      deliver('recordChangesSaved', {
        ...account({ Name: 'Acme Corp' }),
        opId: lastPost('saveRecordChanges').opId,
      });
      expect(tabNames()).toEqual(['Acme Corp']);
    });
  });

  describe('persistence', () => {
    it('persists nothing under an org until that org’s tabs have been loaded', () => {
      loadRecord(account());
      expect(postsOf('saveRecordDetailTabs').every((p) => p.orgId === undefined)).toBe(true);

      deliverState([]);
      loadRecord(globex());
      expect(lastPost('saveRecordDetailTabs').orgId).toBe(ORG_ID);
    });

    it('persists the record tabs with their names once hydrated', () => {
      deliverState([]);
      loadRecord(account());

      expect(lastPost('saveRecordDetailTabs')).toMatchObject({
        orgId: ORG_ID,
        activeTab: 0,
        tabs: [{ recordId: ACCOUNT_ID, name: 'Acme', autoName: true, nameObject: null }],
      });
    });

    it('restores tabs idle: only the activated one loads', () => {
      deliverState(
        [
          { recordId: ACCOUNT_ID, name: 'Acme' },
          { recordId: OTHER_ID, name: 'Globex' },
        ],
        0,
      );

      expect(tabNames()).toEqual(['Acme', 'Globex']);
      // One request, for the restored active tab — not one per tab.
      expect(postsOf('loadRecordDetail')).toHaveLength(1);
      expect(lastPost('loadRecordDetail').recordId).toBe(ACCOUNT_ID);

      clickTab('Globex');
      expect(postsOf('loadRecordDetail')).toHaveLength(2);
      expect(lastPost('loadRecordDetail').recordId).toBe(OTHER_ID);
    });

    it('drops a state reply for an org that is no longer connected', () => {
      deliverState([{ recordId: ACCOUNT_ID, name: 'Acme' }], 0, '00Dsomeotherorg');

      expect(tabNames()).toEqual(['Record']);
      expect(postsOf('loadRecordDetail')).toEqual([]);
    });

    it('keeps work the user already started over the stored tabs', () => {
      loadRecord(account());
      deliverState([{ recordId: OTHER_ID, name: 'Globex' }], 0);

      expect(tabNames()).toEqual(['Acme']);
      // And from now on that is what is persisted for this org.
      expect(lastPost('saveRecordDetailTabs')).toMatchObject({
        orgId: ORG_ID,
        tabs: [{ recordId: ACCOUNT_ID }],
      });
    });
  });

  describe('lifecycle', () => {
    it('asks for the connected org’s tabs when the panel opens', () => {
      expect(postsOf('loadRecordDetailState')).toHaveLength(1);
    });

    it('clears every tab on both org edges, and reloads the new org’s tabs on connect', () => {
      loadRecord(account());
      act(() => w.__showRecordDetail(OTHER_ID));
      deliver('recordDetailLoaded', { ...globex(), opId: lastPost('loadRecordDetail').opId });

      featureHandlers['record-detail'].onOrgConnected();
      expect($('.rec-detail-title')).toBeNull();
      expect(tabNames()).toEqual(['Record']);
      expect(postsOf('loadRecordDetailState')).toHaveLength(2);

      loadRecord(account());
      featureHandlers['record-detail'].onOrgDisconnected();
      expect($('.rec-detail-title')).toBeNull();
      expect(tabNames()).toEqual(['Record']);
      // Disconnecting asks for nothing — there is no org to read tabs for.
      expect(postsOf('loadRecordDetailState')).toHaveLength(2);
    });

    it('drops a reply that arrives after an org edge, and still ends its operation', () => {
      loadRecord(account());
      const pending = lastPost('loadRecordDetail');
      featureHandlers['record-detail'].onOrgDisconnected();

      deliver('recordDetailLoaded', { ...account(), opId: pending.opId });
      expect($('.rec-detail-title')).toBeNull();
      expect(postsOf('operationEnded').filter((p) => p.opId === pending.opId)).toHaveLength(2);
    });

    it('__showRecordDetail switches to SOQL → Record Detail and loads the Id', () => {
      act(() => w.__showRecordDetail(ACCOUNT_ID));

      expect(activated).toEqual(['tab:soql', 'soql-sub-tab-bar:record-detail']);
      expect(lastPost('loadRecordDetail').recordId).toBe(ACCOUNT_ID);
      expect($<HTMLInputElement>('.rec-detail-id-input').value).toBe(ACCOUNT_ID);
    });
  });
});

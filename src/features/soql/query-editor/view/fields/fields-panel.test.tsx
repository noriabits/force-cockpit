// @vitest-environment jsdom
// Characterization tests for the SOQL tab's field browser panel.
//
// WHY THESE EXIST: this module is 465 lines of imperative DOM with no tests at
// all, and it is about to be ported to Preact. A rewrite of an untested module
// is a rewrite with no gate — nothing throws, a checkbox just quietly stops
// reflecting the SELECT clause, or a stale describe paints over a newer one.
//
// WHY THEY LOOK LIKE THIS: they follow `history.test.tsx`, written BEFORE that
// extraction and surviving it with no assertion change. The same three harness
// rules apply, each of which is what makes an assertion true of BOTH the
// imperative code here today and the ported one:
//
//   - Every interaction goes through the act()-wrapped helpers. Against
//     imperative DOM act() is a no-op; against the ported code it flushes
//     Preact's microtask-batched re-render.
//   - Selection is by CLASS, never by id. The port renders the panel body, so
//     the ids in view.html are not part of the contract.
//   - `window.__setTooltip` is stubbed into a Map. It is a webview global
//     (media/modules/tooltip.js) that this module calls unguarded, and the
//     tooltip carries `label · type` — something no DOM query can see.
//
// The fake describeCache can hold a reply open (`defer`), which is what lets
// the stale-async cases below be written at all. Those are the tests the port
// must not change: they are what the imperative `renderSeq` counter exists for,
// and the ported code has to earn the same guarantee structurally.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act } from '@testing-library/preact';
import { createFieldsPanel } from './fields-panel';

const w = window as unknown as Record<string, unknown>;

let tooltips: Map<Element, string>;

// ── Describe fixtures ─────────────────────────────────────────────────────────
type Field = {
  name: string;
  label: string;
  type: string;
  relationshipName: string | null;
  referenceTo: string[];
  picklistValues: string[];
};

const field = (name: string, type: string, extra: Partial<Field> = {}): Field => ({
  name,
  label: `${name} label`,
  type,
  relationshipName: null,
  referenceTo: [],
  picklistValues: [],
  ...extra,
});

const ACCOUNT = {
  fields: [
    field('Id', 'id'),
    field('Name', 'string'),
    field('Industry', 'picklist', { picklistValues: ['Banking', "O'Neil"] }),
    field('Rating', 'picklist', { picklistValues: [] }),
    field('OwnerId', 'reference', { relationshipName: 'Owner', referenceTo: ['User'] }),
  ],
};
const USER = { fields: [field('Id', 'id'), field('Email', 'email'), field('Alias', 'string')] };
const LEAD = { fields: [field('Id', 'id'), field('Company', 'string')] };
// Self-referencing, so a test can expand past SOQL's 5-level traversal limit.
const NODE = {
  fields: [
    field('Id', 'id'),
    field('Stage', 'picklist', { picklistValues: ['A'] }),
    field('ParentId', 'reference', { relationshipName: 'Parent', referenceTo: ['Node'] }),
  ],
};

const GLOBAL = {
  sobjects: [
    { name: 'Account', label: 'Account' },
    { name: 'AccountShare', label: 'Account Share' },
    { name: 'Contact', label: 'Contact' },
    { name: 'Lead', label: 'Lead' },
  ],
};

const DESCRIBES: Record<string, unknown> = {
  account: ACCOUNT,
  user: USER,
  lead: LEAD,
  node: NODE,
};

// ── Fake describe cache ───────────────────────────────────────────────────────
/**
 * Mirrors `autocomplete/describe-cache.js`'s two-method surface. `defer` holds
 * every reply open so a test can resolve them out of order.
 */
function makeDescribeCache() {
  let defer = false;
  const pending: { resolve: () => void }[] = [];
  const sobjectCalls: string[] = [];
  let globalCalls = 0;

  function settle<T>(value: T): Promise<T> {
    if (!defer) return Promise.resolve(value);
    return new Promise<T>((resolve) => pending.push({ resolve: () => resolve(value) }));
  }

  return {
    getGlobal: () => {
      globalCalls++;
      return settle(GLOBAL as unknown);
    },
    getSObject: (name: string) => {
      sobjectCalls.push(name);
      return settle(DESCRIBES[name.toLowerCase()] ?? null);
    },
    // test controls
    sobjectCalls,
    get globalCalls() {
      return globalCalls;
    },
    hold: () => {
      defer = true;
    },
    release: () => {
      defer = false;
    },
    /** Resolve the n-th still-open reply, oldest first. */
    flush: (index = 0) => {
      const [entry] = pending.splice(index, 1);
      entry?.resolve();
    },
    get openReplies() {
      return pending.length;
    },
  };
}

// ── DOM helpers — class based, so the port may drop the ids ───────────────────
const $ = <T extends Element>(sel: string) => document.querySelector(sel) as T;
const $$ = (sel: string) => Array.from(document.querySelectorAll(sel));

const rowEls = () => $$('.query-fields-row') as HTMLElement[];
const names = () => $$('.query-fields-name').map((el) => el.textContent);
const types = () => $$('.query-fields-type').map((el) => el.textContent);
const checkboxes = () => $$('.query-fields-checkbox') as HTMLInputElement[];
const chips = () => $$('.query-fields-picklist-value') as HTMLElement[];
const status = () => $<HTMLElement>('.query-fields-status').textContent;
const banner = () => $<HTMLElement>('.query-fields-banner');

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function type(input: HTMLInputElement, value: string) {
  act(() => {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function toggleCheckbox(box: HTMLInputElement) {
  act(() => {
    box.checked = !box.checked;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/** The next macrotask — where every resolved describe chain has settled. */
const tick = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

/** The row whose `.query-fields-name` is `name`. */
function rowFor(name: string): HTMLElement {
  const el = $$('.query-fields-name').find((n) => n.textContent === name);
  if (!el) throw new Error(`no row for ${name}: have ${JSON.stringify(names())}`);
  return el.parentElement as HTMLElement;
}

const expanderFor = (name: string) =>
  rowFor(name).querySelector('.query-fields-expand') as HTMLButtonElement | null;
const checkboxFor = (name: string) =>
  rowFor(name).querySelector('.query-fields-checkbox') as HTMLInputElement | null;
const indentOf = (name: string) => rowFor(name).style.paddingLeft;

// ── Harness ───────────────────────────────────────────────────────────────────
interface Harness {
  panel: ReturnType<typeof createFieldsPanel>;
  toggleBtn: HTMLButtonElement;
  closeBtn: HTMLButtonElement;
  objectBtn: HTMLButtonElement;
  searchInput: HTMLInputElement;
  panelEl: HTMLElement;
  textarea: HTMLTextAreaElement;
  cache: ReturnType<typeof makeDescribeCache>;
  applyEdit: ReturnType<typeof vi.fn>;
  connected: { value: boolean };
}

function mountPanel(query = ''): Harness {
  document.body.innerHTML = `
    <button class="query-fields-toggle" id="btn-soql-fields">🗂 Fields</button>
    <textarea id="soql-input"></textarea>
    <aside class="query-fields-panel" id="query-fields-panel" style="display: none">
      <div class="query-fields-header">
        <button class="query-fields-object-btn"></button>
        <button class="query-fields-close">✕</button>
      </div>
      <input type="text" class="query-fields-search" />
      <div class="query-fields-list"></div>
      <div class="query-fields-status"></div>
    </aside>`;

  const textarea = $<HTMLTextAreaElement>('#soql-input');
  textarea.value = query;

  const cache = makeDescribeCache();
  const applyEdit = vi.fn();
  const connected = { value: true };

  const panel = createFieldsPanel({
    panelEl: $<HTMLElement>('.query-fields-panel'),
    toggleBtn: $<HTMLButtonElement>('.query-fields-toggle'),
    closeBtn: $<HTMLButtonElement>('.query-fields-close'),
    objectBtn: $<HTMLButtonElement>('.query-fields-object-btn'),
    searchInput: $<HTMLInputElement>('.query-fields-search'),
    listEl: $<HTMLElement>('.query-fields-list'),
    statusEl: $<HTMLElement>('.query-fields-status'),
    textarea,
    describeCache: cache,
    isConnected: () => connected.value,
    applyEdit,
  });

  return {
    panel,
    toggleBtn: $<HTMLButtonElement>('.query-fields-toggle'),
    closeBtn: $<HTMLButtonElement>('.query-fields-close'),
    objectBtn: $<HTMLButtonElement>('.query-fields-object-btn'),
    searchInput: $<HTMLInputElement>('.query-fields-search'),
    panelEl: $<HTMLElement>('.query-fields-panel'),
    textarea,
    cache,
    applyEdit,
    connected,
  };
}

/** Mount, point the query at Account, and open the panel with its fields shown. */
async function mountOpen(query = 'SELECT Id FROM Account'): Promise<Harness> {
  const h = mountPanel(query);
  h.panel.syncFromQuery();
  click(h.toggleBtn);
  await tick();
  return h;
}

/** Retype the query and tell the panel, as index.js's `input` listener does. */
async function setQuery(h: Harness, query: string) {
  h.textarea.value = query;
  act(() => h.panel.syncFromQuery());
  await tick();
}

describe('createFieldsPanel', () => {
  beforeEach(() => {
    tooltips = new Map();
    w.__setTooltip = (el: Element, text: string) => tooltips.set(el, text);
  });

  describe('visibility', () => {
    it('starts closed and renders nothing until the toggle opens it', () => {
      const h = mountPanel('SELECT Id FROM Account');
      expect(h.panelEl.style.display).toBe('none');
      expect(rowEls()).toHaveLength(0);
      expect(h.cache.sobjectCalls).toEqual([]);
    });

    it('opens on the toggle, closes on the toggle and on the ✕', async () => {
      const h = await mountOpen();
      expect(h.panelEl.style.display).not.toBe('none');
      expect(h.toggleBtn.classList.contains('query-fields-toggle--open')).toBe(true);

      click(h.toggleBtn);
      expect(h.panelEl.style.display).toBe('none');
      expect(h.toggleBtn.classList.contains('query-fields-toggle--open')).toBe(false);

      click(h.toggleBtn);
      await tick();
      click(h.closeBtn);
      expect(h.panelEl.style.display).toBe('none');
    });

    it('does not re-render while closed', async () => {
      const h = await mountOpen();
      click(h.toggleBtn); // close
      const before = h.cache.sobjectCalls.length;
      await setQuery(h, 'SELECT Id FROM Lead');
      expect(h.cache.sobjectCalls.length).toBe(before);
    });
  });

  describe('connection', () => {
    it('asks for no describe and explains itself when disconnected', async () => {
      const h = mountPanel('SELECT Id FROM Account');
      h.connected.value = false;
      h.panel.syncFromQuery();
      click(h.toggleBtn);
      await tick();

      expect(status()).toMatch(/connect to an org/i);
      expect(rowEls()).toHaveLength(0);
      expect(h.cache.sobjectCalls).toEqual([]);
    });
  });

  describe('field list', () => {
    it("lists the FROM object's fields with name, type and a label · type tooltip", async () => {
      await mountOpen();
      expect(names()).toEqual(['Id', 'Name', 'Industry', 'Rating', 'OwnerId']);
      expect(types()).toEqual(['id', 'string', 'picklist', 'picklist', 'reference']);
      expect(tooltips.get(rowFor('Name'))).toBe('Name label · string');
      expect(status()).toBe('5 fields on Account');
    });

    it('names the browsed object on the header button', async () => {
      const h = await mountOpen();
      expect(h.objectBtn.textContent).toBe('Account ▾');
    });

    it('prompts for an object when the query has no FROM yet', async () => {
      const h = await mountOpen('SELECT Id FROM ');
      expect(status()).toMatch(/pick an object/i);
      expect(rowEls()).toHaveLength(0);
      expect(h.objectBtn.textContent).toBe('Choose object ▾');
    });

    it('reports a describe that came back empty', async () => {
      await mountOpen('SELECT Id FROM Ghost__c');
      expect(status()).toBe('Could not describe Ghost__c.');
      expect(rowEls()).toHaveLength(0);
    });
  });

  describe('auto-follow', () => {
    it('follows the query onto a new object', async () => {
      const h = await mountOpen();
      await setQuery(h, 'SELECT Id FROM Lead');
      expect(names()).toEqual(['Id', 'Company']);
      expect(h.objectBtn.textContent).toBe('Lead ▾');
    });

    it('keeps following while the object picker is open', async () => {
      // The picker being open is not a deliberate browse — nothing is picked
      // yet. Suppressing the snap here used to land the user on the
      // foreign-browse banner with no checkboxes the moment they closed it.
      const h = await mountOpen();
      click(h.objectBtn);
      await tick();

      await setQuery(h, 'SELECT Id FROM Lead');
      expect(h.objectBtn.textContent).toBe('Lead ▾');

      click(h.objectBtn); // back to the field list
      await tick();
      expect(names()).toEqual(['Id', 'Company']);
      expect(banner()).toBeNull();
      expect(checkboxes().length).toBeGreaterThan(0);
    });

    it('stays put when the query changes but the object does not', async () => {
      const h = await mountOpen();
      click(expanderFor('OwnerId')!);
      await tick();
      expect(names()).toContain('Email');

      await setQuery(h, "SELECT Id FROM Account WHERE Name = 'x'");
      // The expansion survives — this edit is not a change of object.
      expect(names()).toContain('Email');
    });
  });

  describe('foreign browse', () => {
    async function browseElsewhere(): Promise<Harness> {
      const h = await mountOpen();
      click(h.objectBtn); // into the object picker
      await tick();
      click(rowFor('Lead'));
      await tick();
      return h;
    }

    it('warns and drops every checkbox when browsing a foreign object', async () => {
      await browseElsewhere();
      expect(banner()?.textContent).toContain('Browsing Lead');
      expect(banner()?.textContent).toContain('not the object this query selects from');
      expect(checkboxes()).toHaveLength(0);
    });

    it('offers a way back to the query object', async () => {
      const h = await browseElsewhere();
      const back = banner()!.querySelector('.query-fields-back') as HTMLButtonElement;
      expect(back.textContent).toBe('↩ back to Account');

      click(back);
      await tick();
      expect(banner()).toBeNull();
      expect(h.objectBtn.textContent).toBe('Account ▾');
      expect(checkboxes().length).toBeGreaterThan(0);
    });
  });

  describe('selection', () => {
    it('ticks the fields the SELECT clause already names', async () => {
      await mountOpen('SELECT Id, Name FROM Account');
      expect(checkboxFor('Id')!.checked).toBe(true);
      expect(checkboxFor('Name')!.checked).toBe(true);
      expect(checkboxFor('Industry')!.checked).toBe(false);
    });

    it('hands an add edit to applyEdit, never a rewritten query', async () => {
      const h = await mountOpen('SELECT Id FROM Account');
      toggleCheckbox(checkboxFor('Name')!);

      expect(h.applyEdit).toHaveBeenCalledTimes(1);
      const edit = h.applyEdit.mock.calls[0][0];
      expect(edit).toMatchObject({ text: expect.stringContaining('Name') });
      expect(typeof edit.start).toBe('number');
      expect(typeof edit.end).toBe('number');
    });

    it('hands a remove edit when unticking', async () => {
      const h = await mountOpen('SELECT Id, Name FROM Account');
      toggleCheckbox(checkboxFor('Name')!);

      const edit = h.applyEdit.mock.calls[0][0];
      expect(edit.text).toBe('');
      expect('SELECT Id, Name FROM Account'.slice(edit.start, edit.end)).toContain('Name');
    });

    it('refuses to remove the only selected field', async () => {
      const h = await mountOpen('SELECT Id FROM Account');
      toggleCheckbox(checkboxFor('Id')!);
      expect(h.applyEdit).toHaveBeenCalledWith(null);
    });
  });

  describe('relationship expansion', () => {
    it("nests the target's fields under the dotted relationship path", async () => {
      const h = await mountOpen();
      click(expanderFor('OwnerId')!);
      await tick();

      expect(h.cache.sobjectCalls).toContain('User');
      expect(names()).toEqual([
        'Id',
        'Name',
        'Industry',
        'Rating',
        'OwnerId',
        'Id',
        'Email',
        'Alias',
      ]);
      expect(indentOf('OwnerId')).toBe('0px');
      const all = rowEls();
      expect(all[all.length - 1].style.paddingLeft).toBe('14px');
    });

    it('checks a nested field against its dotted path, not its own name', async () => {
      const h = await mountOpen('SELECT Id, Owner.Email FROM Account');
      click(expanderFor('OwnerId')!);
      await tick();

      const nested = $$('.query-fields-name').filter((n) => n.textContent === 'Email');
      const box = (nested[0].parentElement as HTMLElement).querySelector(
        '.query-fields-checkbox',
      ) as HTMLInputElement;
      expect(box.checked).toBe(true);

      toggleCheckbox(box);
      const edit = h.applyEdit.mock.calls[0][0];
      expect('SELECT Id, Owner.Email FROM Account'.slice(edit.start, edit.end)).toContain(
        'Owner.Email',
      );
    });

    it('collapses again on a second click', async () => {
      await mountOpen();
      click(expanderFor('OwnerId')!);
      await tick();
      expect(names()).toContain('Email');

      click(expanderFor('OwnerId')!);
      await tick();
      expect(names()).not.toContain('Email');
    });

    it("stops offering expansion at SOQL's 5-level traversal limit", async () => {
      await mountOpen('SELECT Id FROM Node');
      for (let depth = 0; depth < 5; depth++) {
        const parents = $$('.query-fields-name').filter((n) => n.textContent === 'ParentId');
        const deepest = parents[parents.length - 1].parentElement as HTMLElement;
        const expander = deepest.querySelector('.query-fields-expand') as HTMLButtonElement;
        expect(expander, `depth ${depth} should still expand`).not.toBeNull();
        click(expander);
        await tick();
      }

      const parents = $$('.query-fields-name').filter((n) => n.textContent === 'ParentId');
      const deepest = parents[parents.length - 1].parentElement as HTMLElement;
      expect(deepest.style.paddingLeft).toBe('70px');
      expect(deepest.querySelector('.query-fields-expand')).toBeNull();
    });
  });

  describe('picklist expansion', () => {
    it('shows values as chips and inserts a quoted literal at the caret', async () => {
      const h = await mountOpen('SELECT Id FROM Account WHERE Industry = ');
      h.textarea.selectionStart = 5;
      h.textarea.selectionEnd = 9;

      click(expanderFor('Industry')!);
      await tick();
      expect(chips().map((c) => c.textContent)).toEqual(['Banking', "O'Neil"]);

      click(chips()[0]);
      expect(h.applyEdit).toHaveBeenCalledWith({ start: 5, end: 9, text: "'Banking'" });
    });

    it('escapes a quote in the value', async () => {
      const h = await mountOpen();
      click(expanderFor('Industry')!);
      await tick();
      click(chips()[1]);
      expect(h.applyEdit.mock.calls[0][0].text).toBe("'O\\'Neil'");
    });

    it('says so when a picklist has no active values', async () => {
      await mountOpen();
      click(expanderFor('Rating')!);
      await tick();
      expect($<HTMLElement>('.query-fields-picklist-empty').textContent).toBe('No active values');
    });

    it('needs no describe beyond the object already on screen', async () => {
      // picklistValues ride the describe projection the panel already holds, so
      // expanding one must never reach for another object the way a
      // relationship does.
      const h = await mountOpen();
      click(expanderFor('Industry')!);
      await tick();
      expect(new Set(h.cache.sobjectCalls)).toEqual(new Set(['Account']));
    });
  });

  describe('search', () => {
    it('flattens to the browsed object’s own matching fields', async () => {
      const h = await mountOpen();
      click(expanderFor('OwnerId')!);
      await tick();
      expect(names()).toContain('Email');

      type(h.searchInput, 'nam');
      await tick();
      expect(names()).toEqual(['Name']);
    });

    it('counts what is on screen, not the object total', async () => {
      const h = await mountOpen();
      type(h.searchInput, 'nam');
      await tick();
      expect(names()).toEqual(['Name']);
      expect(status()).toBe('1 of 5 fields on Account');
    });

    it('sets expansion aside rather than clearing it', async () => {
      const h = await mountOpen();
      click(expanderFor('OwnerId')!);
      await tick();

      type(h.searchInput, 'nam');
      await tick();
      type(h.searchInput, '');
      await tick();

      expect(names()).toContain('Email');
    });
  });

  describe('object picker', () => {
    it('lists objects with their labels and switches the browsed object', async () => {
      const h = await mountOpen();
      click(h.objectBtn);
      await tick();

      expect(names()).toEqual(['Account', 'AccountShare', 'Contact', 'Lead']);
      expect(status()).toBe('4 objects');

      click(rowFor('Contact'));
      await tick();
      expect(h.objectBtn.textContent).toBe('Contact ▾');
    });

    it('ranks matches and clears the search box on entry', async () => {
      const h = await mountOpen();
      type(h.searchInput, 'lead');
      await tick();

      click(h.objectBtn);
      await tick();
      expect(h.searchInput.value).toBe('');

      type(h.searchInput, 'account');
      await tick();
      expect(names()).toEqual(['Account', 'AccountShare']);
      expect(status()).toBe('2 objects');
    });

    it('toggles back to the field list', async () => {
      const h = await mountOpen();
      click(h.objectBtn);
      await tick();
      click(h.objectBtn);
      await tick();
      expect(names()).toEqual(['Id', 'Name', 'Industry', 'Rating', 'OwnerId']);
    });
  });

  describe('stale replies', () => {
    it('drops a describe that resolves after the object moved on', async () => {
      const h = await mountOpen();
      h.cache.hold();

      await setQuery(h, 'SELECT Id FROM Node'); // reply 0, held
      await setQuery(h, 'SELECT Id FROM Lead'); // reply 1, held
      expect(h.cache.openReplies).toBe(2);

      h.cache.flush(1); // Lead — the current object
      await tick();
      expect(names()).toEqual(['Id', 'Company']);

      h.cache.flush(0); // Node — superseded, must not paint
      await tick();
      expect(names()).toEqual(['Id', 'Company']);
      expect(h.objectBtn.textContent).toBe('Lead ▾');
    });

    it('drops an object-picker reply that resolves after leaving the picker', async () => {
      const h = await mountOpen();
      h.cache.hold();
      click(h.objectBtn); // picker: getGlobal held
      h.cache.release();
      click(h.objectBtn); // straight back to fields
      await tick();
      h.cache.flush(0); // the held getGlobal lands late
      await tick();

      expect(names()).toEqual(['Id', 'Name', 'Industry', 'Rating', 'OwnerId']);
    });
  });

  describe('onOrgChanged', () => {
    it('re-derives the object from the query text instead of blanking it', async () => {
      const h = await mountOpen();
      act(() => h.panel.onOrgChanged());
      await tick();

      expect(h.objectBtn.textContent).toBe('Account ▾');
      expect(names()).toEqual(['Id', 'Name', 'Industry', 'Rating', 'OwnerId']);
    });

    it('drops a manual browse, an expansion and a search', async () => {
      const h = await mountOpen();
      click(expanderFor('OwnerId')!);
      await tick();
      type(h.searchInput, 'nam');
      await tick();

      act(() => h.panel.onOrgChanged());
      await tick();

      expect(h.searchInput.value).toBe('');
      expect(names()).toEqual(['Id', 'Name', 'Industry', 'Rating', 'OwnerId']);
    });
  });
});

// @vitest-environment jsdom
// Characterization tests for the SOQL tab's query history dropdown.
//
// WHY THESE EXIST: this module is ~90% identical to the REST tab's
// `webview/rest-call/history.tsx`, which has 11 tests, while this one has none.
// The two are about to become one shared component, and a rewrite of an
// untested module is a rewrite with no gate: nothing throws, a pick just
// carries the wrong name or a saved row quietly stops closing.
//
// WHY THEY LOOK LIKE THIS: they are eleven mirrors of `rest-flow.test.tsx`'s
// history block, written BEFORE the extraction and expected to survive it with
// ZERO edits — if one needs changing during the port, the port changed
// behaviour. Hence three harness rules, each of which is what makes an
// assertion true of BOTH the imperative code here today and the ported one:
//
//   - Every interaction goes through the act()-wrapped helpers copied verbatim
//     from rest-flow.test.tsx. Against imperative DOM code act() is a no-op;
//     against the ported code it flushes Preact's microtask-batched re-render.
//   - Focus/selection is asserted after a macrotask tick. This module defers it
//     with setTimeout(…, 0) and the shared component uses a layout effect; only
//     a deferred assertion is true of both.
//   - `window.__setTooltip` is stubbed into a Map. It is a webview global
//     (media/modules/tooltip.js) that this module calls unguarded, and the
//     tooltip IS the full untruncated query — something no DOM query can see.
//
// SCOPE: this drives `createQueryHistory(ctx)` directly, with three hand-made
// elements and spy callbacks, rather than booting `view/index.js`. That bundle
// needs 6.5 KB of view.html plus the highlighter, autocomplete, describe cache,
// fields panel and results table, none of which this component touches. The
// honest cost is that the ctx wiring in index.js (onPick → tabs.openTab,
// onSaved → tabs.renameActiveAsSaved) stays uncovered, as it is today.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from '@testing-library/preact';
import { createQueryHistory } from './history';

type Post = Record<string, unknown>;

let posts: Post[];
let tooltips: Map<Element, string>;

const w = window as unknown as Record<string, unknown>;

const SAVED = {
  name: 'Open cases',
  query: 'SELECT Id FROM Case WHERE IsClosed = false',
  useToolingApi: false,
};
const RECENT = { query: 'SELECT Id, DeveloperName FROM ApexClass', useToolingApi: true };

// ── DOM helpers — class/text based, so the port may drop the ids ───────────────
const $ = <T extends Element>(sel: string) => document.querySelector(sel) as T;
const $$ = (sel: string) => Array.from(document.querySelectorAll(sel));

const rows = () => $$('.query-history-item') as HTMLElement[];
const labels = () => $$('.query-history-item-label') as HTMLElement[];
const dropdownEl = () => $<HTMLElement>('.query-history-dropdown');

// Copied verbatim from rest-flow.test.tsx — see the harness note above.
function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function keydown(el: Element, key: string) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

/** The next macrotask — where both the setTimeout(0) and the layout effect have run. */
const tick = () => new Promise((r) => setTimeout(r, 0));

interface Harness {
  history: ReturnType<typeof createQueryHistory>;
  buttonEl: HTMLButtonElement;
  saveBtn: HTMLButtonElement;
  onPick: ReturnType<typeof vi.fn>;
  onSaved: ReturnType<typeof vi.fn>;
  /** The live editor contents the ctx reads through getCurrent. */
  current: { query: string; useToolingApi: boolean };
  /** What getDefaultName returns — the active tab's own title. */
  defaultName: { value: string };
}

function mountHistory(): Harness {
  document.body.innerHTML = `
    <div class="query-history-wrap">
      <button class="btn btn-ghost" id="btn-query-history">History ▾</button>
      <div class="query-history-dropdown" id="query-history-dropdown" style="display: none"></div>
    </div>
    <button class="btn btn-ghost" id="btn-save-query">★ Save</button>`;

  const buttonEl = $<HTMLButtonElement>('#btn-query-history');
  const saveBtn = $<HTMLButtonElement>('#btn-save-query');
  const current = { query: '', useToolingApi: false };
  const defaultName = { value: '' };
  const onPick = vi.fn();
  const onSaved = vi.fn();

  const history = createQueryHistory({
    buttonEl,
    dropdownEl: dropdownEl(),
    saveBtn,
    // Contextually typed, with the cast at the push: the ctx now declares
    // `(msg: unknown) => void` (a real interface, not the old JSDoc `any`), and
    // under strictFunctionTypes a `(msg: Post)` stub is not assignable to it.
    vscode: { postMessage: (msg) => posts.push(msg as Post) },
    getCurrent: () => ({ ...current }),
    getDefaultName: () => defaultName.value,
    onPick,
    onSaved,
  });

  return { history, buttonEl, saveBtn, onPick, onSaved, current, defaultName };
}

/** Mount and load one Saved + one Recent entry, as `queryStateLoaded` does. */
function mountWithHistory(): Harness {
  const h = mountHistory();
  act(() => h.history.load({ history: [RECENT], savedQueries: [SAVED] }));
  return h;
}

const postsOf = (type: string) => posts.filter((p) => p.type === type);
const lastPost = (type: string) => {
  const all = postsOf(type);
  return all.length ? all[all.length - 1] : undefined;
};

describe('SOQL history dropdown', () => {
  beforeEach(() => {
    posts = [];
    tooltips = new Map();
    w.__setTooltip = (el: Element, text: string) => tooltips.set(el, text);
  });

  // Not a trailing teardown per test: a failing assertion throws before it and
  // leaks the mounted DOM into the next one.
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('toggles open and closed, and closes on an outside click', () => {
    const { buttonEl } = mountWithHistory();

    click(buttonEl);
    expect(dropdownEl().style.display).not.toBe('none');
    click(buttonEl);
    expect(dropdownEl().style.display).toBe('none');

    click(buttonEl);
    click(document.body);
    expect(dropdownEl().style.display).toBe('none');
  });

  it('renders both sections with counts, the Tooling badge and the full-query tooltip', () => {
    const { buttonEl } = mountWithHistory();
    click(buttonEl);

    const titles = $$('.query-history-section-title').map((e) => e.textContent);
    expect(titles).toEqual(['Saved (1)', 'Recent (1)']);
    // The badge is conditional here, unlike REST's method badge: only the
    // Tooling-API entry carries one, and SAVED does not.
    expect($$('.query-history-badge').map((e) => e.textContent)).toEqual(['Tooling']);
    // ...and it LEADS the row, as the REST tab's method badge does.
    expect(Array.from(rows()[1].children).map((c) => c.className)).toEqual([
      'query-history-badge',
      'query-history-item-label',
    ]);
    // Saved rows show their own label; Recent rows show the query text.
    expect(labels().map((e) => e.textContent)).toEqual([SAVED.name, RECENT.query]);
    // The row text is elided; the tooltip carries the whole query.
    expect(labels().map((e) => tooltips.get(e))).toEqual([SAVED.query, RECENT.query]);
    expect(tooltips.get($('.query-history-remove'))).toBe('Remove saved query');
  });

  it('collapses whitespace and elides a long recent query in the row text', () => {
    const h = mountHistory();
    const long = `SELECT Id,\n  Name,\n  ${'X'.repeat(80)}\nFROM Account`;
    act(() =>
      h.history.load({ history: [{ query: long, useToolingApi: false }], savedQueries: [] }),
    );
    click(h.buttonEl);

    const text = labels()[0].textContent ?? '';
    expect(text).toHaveLength(71); // 70 + the ellipsis
    expect(text.endsWith('…')).toBe(true);
    expect(text).not.toContain('\n');
    // The untruncated original is still reachable through the tooltip.
    expect(tooltips.get(labels()[0])).toBe(long);
  });

  it('shows the empty copy for each section independently', () => {
    const h = mountHistory();
    act(() => h.history.load({ history: [], savedQueries: [] }));
    click(h.buttonEl);

    expect($$('.query-history-empty').map((e) => e.textContent)).toEqual([
      'No saved queries.',
      'No recent queries.',
    ]);
  });

  it('picks a Recent entry with no name, and closes', () => {
    const { buttonEl, onPick } = mountWithHistory();
    click(buttonEl);
    click(labels()[1]);

    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0]).toEqual({
      query: RECENT.query,
      useToolingApi: true,
      name: undefined,
    });
    expect(dropdownEl().style.display).toBe('none');
  });

  it('picks a Saved entry carrying its own name', () => {
    const { buttonEl, onPick } = mountWithHistory();
    click(buttonEl);
    click(labels()[0]);

    expect(onPick.mock.calls[0][0]).toEqual({
      query: SAVED.query,
      useToolingApi: false,
      name: SAVED.name,
    });
  });

  it('pre-fills and pre-selects the save input with the active tab name', async () => {
    const h = mountWithHistory();
    h.defaultName.value = 'Account';

    click(h.saveBtn);
    const input = $<HTMLInputElement>('.query-history-save-input');
    expect(input.value).toBe('Account');

    // Focus + select is deferred, so the whole value is replaceable by typing.
    await tick();
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
  });

  it('saves under a typed name, reports it, and closes the save row', () => {
    const h = mountWithHistory();
    h.current.query = 'SELECT Id FROM Lead';
    h.current.useToolingApi = false;

    click(h.saveBtn);
    const input = $<HTMLInputElement>('.query-history-save-input');
    input.value = 'New leads';
    keydown(input, 'Enter');

    const posted = lastPost('saveSavedQueries') as { savedQueries: Post[] };
    expect(posted.savedQueries[0]).toMatchObject({
      name: 'New leads',
      query: 'SELECT Id FROM Lead',
      useToolingApi: false,
    });
    // The previously saved entry is kept, below the new one.
    expect(posted.savedQueries).toHaveLength(2);
    // The tab the user was looking at takes the name they just typed.
    expect(h.onSaved).toHaveBeenCalledWith('New leads');
    expect($('.query-history-save-input')).toBeNull();
  });

  it('refuses to save a blank name or an empty query', () => {
    const h = mountWithHistory();
    click(h.saveBtn);
    const input = $<HTMLInputElement>('.query-history-save-input');

    input.value = '   ';
    keydown(input, 'Enter');
    expect(postsOf('saveSavedQueries')).toHaveLength(0);

    input.value = 'Named'; // the query is still empty
    keydown(input, 'Enter');
    expect(postsOf('saveSavedQueries')).toHaveLength(0);
    expect(h.onSaved).not.toHaveBeenCalled();
  });

  it('abandons the save row on Escape', () => {
    const h = mountWithHistory();
    click(h.saveBtn);
    keydown($<HTMLInputElement>('.query-history-save-input'), 'Escape');

    expect($('.query-history-save-input')).toBeNull();
    expect(postsOf('saveSavedQueries')).toHaveLength(0);
  });

  it('keeps a half-typed save name when the host pushes an updated list', () => {
    const h = mountWithHistory();
    h.defaultName.value = 'Account';
    click(h.saveBtn);

    const input = $<HTMLInputElement>('.query-history-save-input');
    input.value = 'Half-typed name';

    // Reachable in one ordinary sequence: run a query, open ★ Save while it is
    // still in flight, start typing, and the result lands — recordRun posts
    // addQueryHistory and the host echoes the updated list straight back.
    act(() => h.history.onHistoryUpdated([RECENT, RECENT]));

    // The same input element, still holding what the user typed — not a fresh
    // one re-seeded from getDefaultName.
    expect($('.query-history-save-input')).toBe(input);
    expect(input.value).toBe('Half-typed name');
    // ...and the pushed list did land.
    expect($$('.query-history-section-title')[1].textContent).toBe('Recent (2)');
  });

  it('removes a saved query without opening it', () => {
    const { buttonEl, onPick } = mountWithHistory();
    click(buttonEl);
    click($('.query-history-remove'));

    expect((lastPost('saveSavedQueries') as { savedQueries: Post[] }).savedQueries).toEqual([]);
    expect(onPick).not.toHaveBeenCalled(); // the click never reached the row's own handler
    expect(rows()).toHaveLength(1); // only Recent left
  });

  it('re-renders in place when the host pushes updated lists', () => {
    const h = mountWithHistory();
    click(h.buttonEl);

    act(() => h.history.onHistoryUpdated([RECENT, RECENT]));
    expect($$('.query-history-section-title')[1].textContent).toBe('Recent (2)');

    act(() => h.history.onSavedUpdated([]));
    expect($$('.query-history-section-title')[0].textContent).toBe('Saved (0)');
    expect(rows()).toHaveLength(2);
  });

  it('records a run, and never an empty one', () => {
    const h = mountWithHistory();

    h.history.recordRun('   ', false);
    expect(postsOf('addQueryHistory')).toHaveLength(0);

    h.history.recordRun('SELECT Id FROM Account', true);
    expect(lastPost('addQueryHistory')).toEqual({
      type: 'addQueryHistory',
      query: 'SELECT Id FROM Account',
      useToolingApi: true,
    });
  });
});

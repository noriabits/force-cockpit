// @vitest-environment jsdom
// Characterization tests for the REST tab bundle.
//
// WHY THESE EXIST: this is the only webview bundle with no coverage, and six of
// its behaviours are each a bug that was found and fixed once — they are recorded
// as comments in index.js and nowhere else. They are exactly the kind that break
// silently under a rewrite: nothing throws, a reply just lands in the wrong tab.
//
// WHY THEY LOOK LIKE THIS: every one drives the bundle through its real seams —
// the DOM, `__onMessage` replies, the `__registerFeature` org edges — and never
// reaches inside a module. That is deliberate. These are written BEFORE the Preact
// migration and must survive it with `mountRestTab()` as the ONLY edit: the markup
// fixture below collapses to a single mount container, and every stub, selector
// and assertion stays untouched. If a test here needs changing during the port,
// the port changed behaviour.
//
// Hence: selectors are class- and text-based, never id-based, so the port can drop
// the 19 ids the static markup carries today.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from '@testing-library/preact';

// ── The static markup, verbatim from webviews/main.html ────────────────────────
// Kept as one string so the port's only diff here is replacing it with the empty
// mount container. Trimmed of the sibling intro card, which the bundle never touches.
const REST_MARKUP = `
<section class="card" id="restcall-card">
  <div class="query-tab-bar" id="rest-tab-bar"></div>
  <div class="rest-request-row">
    <select id="rest-method" class="text-input rest-method" aria-label="HTTP method">
      <option value="GET">GET</option>
      <option value="POST">POST</option>
      <option value="PUT">PUT</option>
      <option value="PATCH">PATCH</option>
      <option value="DELETE">DELETE</option>
    </select>
    <div class="input-with-paste" style="width: 100%">
      <input type="text" id="rest-endpoint" class="text-input rest-endpoint" spellcheck="false"
             placeholder="/services/data/v65.0/sobjects/Account" aria-label="Endpoint path" />
      <button type="button" class="paste-btn" data-tooltip="Paste from clipboard"
              aria-label="Paste from clipboard">&#128203;</button>
    </div>
  </div>

  <div class="rest-headers-section">
    <div class="rest-headers-section-title">Headers</div>
    <div class="rest-headers-list" id="rest-headers-list"></div>
    <button type="button" class="btn btn-ghost" id="btn-rest-add-header">+ Add header</button>
  </div>

  <textarea id="rest-body" class="rest-body-textarea" spellcheck="false" placeholder="{ }" rows="6"></textarea>

  <div class="query-toolbar">
    <button class="btn btn-primary" id="btn-rest-send">Send</button>
    <button class="btn btn-ghost" id="btn-rest-clone" data-tooltip="Clone the current tab into a new tab"
            aria-label="Clone the current request tab">&#10697; Clone</button>
    <div class="query-history-wrap">
      <button class="btn btn-ghost" id="btn-rest-history">History &#9662;</button>
      <div class="query-history-dropdown" id="rest-history-dropdown" style="display: none"></div>
    </div>
    <button class="btn btn-ghost" id="btn-rest-save-request" data-tooltip="Save current request"
            aria-label="Save current request">&#9733; Save</button>
  </div>

  <div id="rest-response" style="display: none"></div>

  <div id="rest-error" class="error-box" style="display: none"></div>
</section>`;

// ── Harness ────────────────────────────────────────────────────────────────────
type Post = Record<string, any>;

let posts: Post[];
let inbound: Map<string, (msg: any) => void>;
let featureHandlers: Record<string, any>;
/** Callbacks stashed by the __confirmIfSensitive stub instead of being invoked. */
let pendingConfirms: Array<() => void>;
/** What __setTooltip was called with — the tooltip IS the label on several of
 *  these controls, and a port that drops it breaks nothing a DOM query can see. */
let tooltips: Map<Element, string>;

const w = window as unknown as Record<string, any>;

/** Byte-for-byte the escaper in media/modules/ipc.js — `&` first, which is what
 *  makes the escape bijective and the post-migration raw-text tokenizer equivalent. */
function escapeHtml(str: unknown): string {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function installGlobals() {
  posts = [];
  inbound = new Map();
  featureHandlers = {};
  pendingConfirms = [];

  w.__vscode = { postMessage: (msg: Post) => posts.push(msg) };
  w.__escapeHtml = escapeHtml;
  tooltips = new Map();
  w.__setTooltip = (el: Element, text: string) => tooltips.set(el, text);
  w.__onMessage = (type: string, handler: (msg: any) => void) => inbound.set(type, handler);
  w.__registerFeature = (id: string, handlers: any) => {
    featureHandlers[id] = handlers;
  };
  w.__orgConnected = true;
  w.__currentOrg = { sandboxName: null, isProtectedOrg: true };
  // Stash rather than invoke: the real one is asynchronous (a native modal), and
  // invariants (b) and (d) exist entirely because of that gap.
  w.__confirmIfSensitive = (_org: any, _label: string, onConfirmed: () => void) => {
    pendingConfirms.push(onConfirmed);
  };
  w.__confirmAction = (_prompt: string, onConfirmed: () => void) => onConfirmed();
}

async function mountRestTab() {
  document.body.innerHTML = REST_MARKUP;
  vi.resetModules();
  await import('./index');
}

// ── DOM helpers — class/text based so the port can drop every id ───────────────
const $ = <T extends Element>(sel: string) => document.querySelector(sel) as T;
const $$ = (sel: string) => Array.from(document.querySelectorAll(sel));

function btnByText(text: string): HTMLButtonElement {
  const found = $$('button').find((b) => (b.textContent || '').trim().startsWith(text));
  if (!found) throw new Error(`No button starting with "${text}"`);
  return found as HTMLButtonElement;
}

const endpointEl = () => $<HTMLInputElement>('.rest-endpoint');
const methodEl = () => $<HTMLSelectElement>('.rest-method');
const bodyEl = () => $<HTMLTextAreaElement>('.rest-body-textarea');
const sendBtn = () => btnByText('Send');
const pills = () => $$('.query-tab') as HTMLElement[];
const responsePre = () => $<HTMLElement>('.rest-response-body');

// Every interaction is wrapped in act() so Preact's render queue is flushed
// before the assertion reads the DOM. Preact batches signal-driven re-renders
// into a microtask — invisible in the webview, where the browser paints after
// microtasks, but visible to a test that clicks and reads synchronously. This is
// the harness adapting to the framework; no assertion below depends on it, and
// the helpers behave identically against imperative DOM code.
function setValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
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

function keydown(el: Element, key: string) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

/** Deliver a host reply through the same registry media/main.js dispatches into. */
function deliver(type: string, data: unknown) {
  const handler = inbound.get(type);
  if (!handler) throw new Error(`No handler registered for "${type}"`);
  act(() => handler({ type, data }));
}

const postsOf = (type: string) => posts.filter((p) => p.type === type);
// Not `.at(-1)`: tsconfig.webview.json's lib stops at ES2020.
const lastPost = (type: string) => {
  const all = postsOf(type);
  return all.length ? all[all.length - 1] : undefined;
};

/** The opId of the most recent outbound restCall. */
function lastOpId(): string {
  const sent = lastPost('restCall');
  if (!sent) throw new Error('No restCall was posted');
  return sent.opId;
}

/** Load the tab/history state the bundle asks for on boot. */
function loadEmptyState() {
  deliver('restCallStateLoaded', { tabs: [], activeTab: 0, history: [], savedRequests: [] });
}

/** Fire a GET send that needs no confirmation, and return its opId. */
function sendGet(endpoint: string): string {
  setValue(endpointEl(), endpoint);
  click(sendBtn());
  return lastOpId();
}

const okResult = (opId: string, over: Post = {}) => ({
  opId,
  status: 200,
  statusText: 'OK',
  headers: { 'Content-Type': 'application/json' },
  body: '{"ok":true}',
  ...over,
});

describe('REST tab flow', () => {
  beforeEach(installGlobals);
  // Not a trailing teardown per test: a failing assertion throws before it and
  // leaks the mounted DOM into the next one.
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('boots by asking the host for persisted state', async () => {
    await mountRestTab();
    expect(postsOf('loadRestCallState')).toHaveLength(1);
    // One seeded tab, painted by the strip's construction tail.
    expect(pills()).toHaveLength(1);
  });

  // ── (a) ──────────────────────────────────────────────────────────────────────
  it('records history from the request AS SENT, not as the form holds it at reply time', async () => {
    await mountRestTab();
    loadEmptyState();

    const opId = sendGet('/E1');

    // Everything the user could plausibly do while the request is in flight.
    setValue(endpointEl(), '/E2');
    click(btnByText('+'));
    setValue(endpointEl(), '/E3');

    deliver('restCallResult', okResult(opId));

    const recorded = lastPost('addRestCallHistory');
    expect(recorded).toBeDefined();
    expect(recorded!.endpoint).toBe('/E1');
  });

  // ── (b) ──────────────────────────────────────────────────────────────────────
  it('sends the tab and payload captured at click time, not at confirm time', async () => {
    await mountRestTab();
    loadEmptyState();

    setValue(methodEl(), 'POST');
    setValue(endpointEl(), '/E1');
    setValue(bodyEl(), '{"a":1}');
    click(sendBtn());
    // The modal is open: nothing has gone out yet.
    expect(postsOf('restCall')).toHaveLength(0);

    // The user moves on while the modal is up.
    click(btnByText('+'));
    setValue(endpointEl(), '/E2');
    setValue(bodyEl(), '{"b":2}');

    pendingConfirms[0]();

    const sent = lastPost('restCall');
    expect(sent).toMatchObject({ method: 'POST', endpoint: '/E1', body: '{"a":1}' });
  });

  // ── (c) ──────────────────────────────────────────────────────────────────────
  it('drops a reply whose tab was closed — but still ends the operation', async () => {
    await mountRestTab();
    loadEmptyState();

    const opId = sendGet('/E1');
    click(btnByText('+')); // a second tab, so the first one's × appears
    click($('.query-tab .query-tab-close'));

    posts.length = 0;
    deliver('restCallResult', okResult(opId));

    expect(postsOf('addRestCallHistory')).toHaveLength(0);
    expect($<HTMLElement>('#rest-response').style.display).toBe('none');
    // Ending the op happens in ownerOf BEFORE the drop, and is the easiest part
    // of this path to lose in a rewrite — without it the host stays "busy".
    expect(postsOf('operationEnded').some((p) => p.opId === opId)).toBe(true);
  });

  // ── (d) ──────────────────────────────────────────────────────────────────────
  it('paints the Send button from whichever tab is active, not the one that ran', async () => {
    await mountRestTab();
    loadEmptyState();

    setValue(methodEl(), 'POST');
    setValue(endpointEl(), '/E1');
    click(sendBtn());
    click(btnByText('+')); // switch away before confirming
    pendingConfirms[0]();

    // Tab 1 is running; tab 2 is not, and tab 2 is what the user is looking at.
    expect(sendBtn().disabled).toBe(false);
    expect(sendBtn().classList.contains('running')).toBe(false);
    expect($('.action-cancel-btn')).toBeNull();

    // Switching back to the running tab must repaint it as running.
    click(pills()[0].querySelector('.query-tab-label')!);
    expect(sendBtn().disabled).toBe(true);
    expect(sendBtn().classList.contains('running')).toBe(true);
    expect($('.action-cancel-btn')).not.toBeNull();
  });

  it('cancels the run owned by the tab that is active when Cancel is clicked', async () => {
    await mountRestTab();
    loadEmptyState();

    const opId = sendGet('/E1');
    click($('.action-cancel-btn'));

    expect(postsOf('cancelOperation').some((p) => p.opId === opId)).toBe(true);
    expect(sendBtn().disabled).toBe(false);
    expect($('.action-cancel-btn')).toBeNull();
  });

  // PRE-EXISTING DEFECT, pinned so the migration neither inherits it silently nor
  // "fixes" it by accident. `dispatchSend` assigns `tab.opId` directly (it must —
  // the tab is captured, and `setActiveOpId` targets whichever tab is active),
  // but it does so AFTER `settleRun`'s renderBar and never re-renders. So the pill
  // of a run that has just started shows no `⋯` until the next unrelated render.
  // The Send button is painted correctly, so only the background-run marker is
  // affected. Fix = one repaint in dispatchSend; deliberately NOT done here,
  // because a test-only commit must not change behaviour.
  it('DEFECT: a freshly dispatched run does not repaint its own pill', async () => {
    await mountRestTab();
    loadEmptyState();

    sendGet('/E1');
    expect($$('.query-tab--running')).toHaveLength(0); // should be 1

    // Any later render picks it up, which is why this is invisible in practice
    // the moment the user touches anything.
    click(btnByText('+'));
    expect($$('.query-tab--running')).toHaveLength(1);
  });

  // ── (e) ──────────────────────────────────────────────────────────────────────
  // Both edges, because an org-to-org switch never fires the disconnect edge.
  // (That host-side fact belongs to OrgConnectionController; what is pinned here
  // is only that this bundle wires BOTH.)
  for (const edge of ['onOrgConnected', 'onOrgDisconnected'] as const) {
    it(`stops every running tab on ${edge}`, async () => {
      await mountRestTab();
      loadEmptyState();

      const first = sendGet('/E1');
      click(btnByText('+'));
      const second = sendGet('/E2');

      posts.length = 0;
      featureHandlers['rest-call'][edge]();

      const cancelled = postsOf('cancelOperation').map((p) => p.opId);
      expect(cancelled).toContain(first);
      expect(cancelled).toContain(second);
      expect($$('.query-tab--running')).toHaveLength(0);
      expect(sendBtn().disabled).toBe(false);
    });
  }

  it('stops every running tab on cancelAllOperations', async () => {
    await mountRestTab();
    loadEmptyState();

    const opId = sendGet('/E1');
    posts.length = 0;
    deliver('cancelAllOperations', {});

    expect(postsOf('cancelOperation').some((p) => p.opId === opId)).toBe(true);
    expect($$('.query-tab--running')).toHaveLength(0);
  });

  // ── (f) ──────────────────────────────────────────────────────────────────────
  it('keeps blank header rows across a tab switch but never sends them', async () => {
    await mountRestTab();
    loadEmptyState();

    click(btnByText('+ Add header'));
    click(btnByText('+ Add header'));
    const [firstKey] = $$('.rest-header-key') as HTMLInputElement[];
    setValue(firstKey, 'X-Custom');
    setValue($$('.rest-header-value')[0] as HTMLInputElement, 'yes');
    setValue(endpointEl(), '/E1');

    click(btnByText('+')); // persists synchronously
    const persisted = lastPost('saveRestCallTabs');
    expect(persisted!.tabs[0].headers).toHaveLength(2);

    click(pills()[0].querySelector('.query-tab-label')!);
    expect($$('.rest-header-row')).toHaveLength(2);

    click(sendBtn());
    expect(lastPost('restCall')!.headers).toEqual([{ key: 'X-Custom', value: 'yes' }]);
  });

  // ── Guards on send ───────────────────────────────────────────────────────────
  it('refuses to send with no endpoint, and with no org', async () => {
    await mountRestTab();
    loadEmptyState();

    click(sendBtn());
    expect(postsOf('restCall')).toHaveLength(0);
    expect($<HTMLElement>('.error-box').textContent).toBe('Enter an endpoint path.');

    w.__orgConnected = false;
    setValue(endpointEl(), '/E1');
    click(sendBtn());
    expect(postsOf('restCall')).toHaveLength(0);
    expect($<HTMLElement>('.error-box').textContent).toBe('Not connected to any org.');
  });

  it('sends a GET without confirmation but gates every destructive verb', async () => {
    await mountRestTab();
    loadEmptyState();
    setValue(endpointEl(), '/E1');

    click(sendBtn());
    expect(pendingConfirms).toHaveLength(0);
    expect(postsOf('restCall')).toHaveLength(1);

    for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      setValue(methodEl(), verb);
      click(sendBtn());
    }
    expect(pendingConfirms).toHaveLength(4);
  });
});

// ── History dropdown ───────────────────────────────────────────────────────────
describe('REST history dropdown', () => {
  beforeEach(installGlobals);
  afterEach(() => {
    document.body.innerHTML = '';
  });

  const SAVED = {
    name: 'Nightly sync',
    method: 'POST',
    endpoint: '/services/apexrest/Sync',
    body: '{"n":1}',
    headers: [{ key: 'X-A', value: '1' }],
  };
  const RECENT = { method: 'GET', endpoint: '/services/data/v65.0/limits', body: '', headers: [] };

  const openHistory = () => click(btnByText('History'));
  const rows = () => $$('.query-history-item') as HTMLElement[];
  const labels = () => $$('.query-history-item-label') as HTMLElement[];

  async function mountWithHistory() {
    await mountRestTab();
    deliver('restCallStateLoaded', {
      tabs: [],
      activeTab: 0,
      history: [RECENT],
      savedRequests: [SAVED],
    });
  }

  it('toggles open and closed, and closes on an outside click', async () => {
    await mountWithHistory();
    const dropdown = $<HTMLElement>('.query-history-dropdown');

    openHistory();
    expect(dropdown.style.display).not.toBe('none');
    openHistory();
    expect(dropdown.style.display).toBe('none');

    openHistory();
    click(document.body);
    expect(dropdown.style.display).toBe('none');
  });

  it('renders both sections with counts, the method badge and the full-request tooltip', async () => {
    await mountWithHistory();
    openHistory();

    const titles = $$('.query-history-section-title').map((e) => e.textContent);
    expect(titles).toEqual(['Saved (1)', 'Recent (1)']);
    expect($$('.query-history-tooling-badge').map((e) => e.textContent)).toEqual(['POST', 'GET']);
    // Saved rows show their own label; Recent rows show the endpoint.
    expect(labels().map((e) => e.textContent)).toEqual([SAVED.name, RECENT.endpoint]);
    // The row text is elided; the tooltip carries the whole request.
    expect(labels().map((e) => tooltips.get(e))).toEqual([
      `${SAVED.method} ${SAVED.endpoint}`,
      `${RECENT.method} ${RECENT.endpoint}`,
    ]);
    expect(tooltips.get($('.query-history-remove'))).toBe('Remove saved request');
  });

  it('shows the empty copy for each section independently', async () => {
    await mountRestTab();
    deliver('restCallStateLoaded', { tabs: [], activeTab: 0, history: [], savedRequests: [] });
    openHistory();
    expect($$('.query-history-empty').map((e) => e.textContent)).toEqual([
      'No saved requests.',
      'No recent requests.',
    ]);
  });

  it('opens a Recent pick in its own tab, auto-named, without a Saved label', async () => {
    await mountWithHistory();
    setValue(endpointEl(), '/occupied'); // active tab is no longer pristine
    openHistory();
    click(labels()[1]);

    expect(pills()).toHaveLength(2);
    expect(endpointEl().value).toBe(RECENT.endpoint);
    // Auto-named from the endpoint's last segment, not from any saved label.
    expect(pills()[1].textContent).toContain('limits');
    expect($<HTMLElement>('.query-history-dropdown').style.display).toBe('none');
  });

  it('adopts a Saved pick label onto the tab it opens', async () => {
    await mountWithHistory();
    setValue(endpointEl(), '/occupied');
    openHistory();
    click(labels()[0]);

    expect(endpointEl().value).toBe(SAVED.endpoint);
    expect(methodEl().value).toBe('POST');
    expect(bodyEl().value).toBe(SAVED.body);
    expect($$('.rest-header-row')).toHaveLength(1);
    expect(pills()[1].textContent).toContain(SAVED.name);
  });

  it('pre-fills and pre-selects the save input with the active tab name', async () => {
    await mountWithHistory();
    setValue(endpointEl(), '/services/data/v65.0/sobjects/Account');

    click(btnByText('★ Save'));
    const input = $<HTMLInputElement>('.query-history-save-input');
    expect(input.value).toBe('Account'); // the tab's own auto-derived title

    // Focus + select is deferred, so the whole value is replaceable by typing.
    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
  });

  it('saves under a typed name, relabels the open tab, and closes the save row', async () => {
    await mountWithHistory();
    setValue(endpointEl(), '/services/data/v65.0/limits');

    click(btnByText('★ Save'));
    const input = $<HTMLInputElement>('.query-history-save-input');
    input.value = 'Org limits';
    keydown(input, 'Enter');

    const posted = lastPost('saveRestCallSavedRequests');
    expect(posted!.savedRequests[0]).toMatchObject({
      name: 'Org limits',
      endpoint: '/services/data/v65.0/limits',
    });
    // The tab the user was looking at takes the name they just typed.
    expect(pills()[0].textContent).toContain('Org limits');
    expect($('.query-history-save-input')).toBeNull();
  });

  it('refuses to save a blank name or an empty endpoint', async () => {
    await mountWithHistory();
    click(btnByText('★ Save'));
    const input = $<HTMLInputElement>('.query-history-save-input');

    input.value = '   ';
    keydown(input, 'Enter');
    expect(postsOf('saveRestCallSavedRequests')).toHaveLength(0);

    input.value = 'Named'; // endpoint is still empty
    keydown(input, 'Enter');
    expect(postsOf('saveRestCallSavedRequests')).toHaveLength(0);
  });

  it('abandons the save row on Escape', async () => {
    await mountWithHistory();
    click(btnByText('★ Save'));
    keydown($<HTMLInputElement>('.query-history-save-input'), 'Escape');
    expect($('.query-history-save-input')).toBeNull();
    expect(postsOf('saveRestCallSavedRequests')).toHaveLength(0);
  });

  it('removes a saved request without opening it', async () => {
    await mountWithHistory();
    openHistory();
    click($('.query-history-remove'));

    expect(lastPost('saveRestCallSavedRequests')!.savedRequests).toEqual([]);
    expect(pills()).toHaveLength(1); // the click never reached the row's own handler
    expect($$('.query-history-item')).toHaveLength(1); // only Recent left
  });

  it('re-renders in place when the host pushes updated lists', async () => {
    await mountWithHistory();
    openHistory();

    deliver('restCallHistoryUpdated', { history: [RECENT, RECENT] });
    expect($$('.query-history-section-title')[1].textContent).toBe('Recent (2)');

    deliver('restCallSavedRequestsUpdated', { savedRequests: [] });
    expect($$('.query-history-section-title')[0].textContent).toBe('Saved (0)');
    expect(rows()).toHaveLength(2);
  });
});

// ── Response rendering ─────────────────────────────────────────────────────────
// Asserted through the rendered <pre> rather than against formatBodyHtml, which is
// a closure and not exported: only DOM assertions survive the port verbatim. These
// are also what verify the innerHTML-to-nodes change is behaviour-preserving.
describe('REST response rendering', () => {
  beforeEach(installGlobals);
  afterEach(() => {
    document.body.innerHTML = '';
  });

  async function showBody(body: unknown, over: Post = {}) {
    await mountRestTab();
    loadEmptyState();
    const opId = sendGet('/E1');
    deliver('restCallResult', okResult(opId, { body, ...over }));
  }

  // Checksum computed with src/utils/salesforce.ts's own computeIdSuffix, so
  // these stay valid if that ever changes shape.
  const VALID_ID = '001AB00000ABCDEYA5';
  const BAD_ID = '001AB00000ABCDEFGH'; // well-formed, wrong suffix

  it('links a checksum-valid quoted record Id and opens it on click', async () => {
    await showBody(`{"Id":"${VALID_ID}"}`);
    const links = $$('a.rest-response-id-link');
    expect(links).toHaveLength(1);
    expect(links[0].textContent).toBe(VALID_ID);
    expect((links[0] as HTMLElement).dataset.recordId).toBe(VALID_ID);

    click(links[0]);
    expect(lastPost('openRecord')).toMatchObject({ recordId: VALID_ID });
  });

  it('leaves an 18-char token with a broken checksum as plain text', async () => {
    await showBody(`{"Id":"${BAD_ID}"}`);
    expect($$('a.rest-response-id-link')).toHaveLength(0);
    expect(responsePre().textContent).toContain(BAD_ID);
  });

  it('links exactly once when two ids share a quote', async () => {
    await showBody(`"${VALID_ID}"${VALID_ID}"`);
    expect($$('a.rest-response-id-link')).toHaveLength(1);
  });

  it('never injects markup from the response body', async () => {
    await showBody('{"x":"<script>alert(1)</script>"}');
    expect(responsePre().querySelector('script')).toBeNull();
    expect(responsePre().textContent).toContain('<script>alert(1)</script>');
  });

  it('renders a literal &quot; from the body verbatim', async () => {
    // The escaper replaces & first, so this must not be read back as a quote —
    // the property the raw-text tokenizer has to preserve.
    await showBody('{"x":"&quot;"}');
    expect(responsePre().textContent).toContain('&quot;');
    expect($$('a.rest-response-id-link')).toHaveLength(0);
  });

  it('pretty-prints a JSON body and reports an empty one', async () => {
    await showBody('{"a":1}');
    expect(responsePre().textContent).toBe('{\n  "a": 1\n}');

    await showBody('');
    expect(responsePre().textContent).toBe('(empty response)');
  });

  it('colour-codes the status badge and the body border', async () => {
    for (const [status, suffix] of [
      [200, 'ok'],
      [404, 'warn'],
      [500, 'error'],
    ] as const) {
      await showBody('{}', { status });
      expect($('.rest-response-status')!.className).toContain(`rest-response-status--${suffix}`);
      expect(responsePre().className).toContain(`rest-response-body--${suffix}`);
    }
  });

  it('notes a transparently refreshed session next to the status', async () => {
    await showBody('{}', { sessionRefreshed: true });
    expect($('.rest-response-status')!.textContent).toContain('session refreshed');
  });

  it('shows an error instead of a response, and hides the response box', async () => {
    await mountRestTab();
    loadEmptyState();
    const opId = sendGet('/E1');
    deliver('restCallError', { opId, message: 'socket hang up' });

    expect($<HTMLElement>('#rest-response').style.display).toBe('none');
    expect($<HTMLElement>('.error-box').textContent).toBe('socket hang up');
  });
});

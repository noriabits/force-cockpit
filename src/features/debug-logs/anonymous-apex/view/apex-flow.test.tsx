// @vitest-environment jsdom
// Flow tests for the ▶️ Apex bundle, in rest-flow.test.tsx's style: driven only
// through the real seams — the DOM, `__onMessage` replies, the `__registerFeature`
// org edges — and selecting by class and text, never reaching inside a module.
// The bundle mounts over the REAL view.html, so the Debug Logs viewer it reuses
// is exercised against the markup it actually ships with.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/preact';
import '../labels.js';

type Post = Record<string, any>;

let posts: Post[];
let inbound: Map<string, (msg: any) => void>;
let featureHandlers: Record<string, any>;
/** Callbacks stashed by the __confirmIfSensitive stub instead of being invoked. */
let pendingConfirms: Array<() => void>;
let newScripts: string[];

const w = window as unknown as Record<string, any>;

function installGlobals() {
  posts = [];
  inbound = new Map();
  featureHandlers = {};
  pendingConfirms = [];
  newScripts = [];
  w.__vscode = { postMessage: (msg: Post) => posts.push(msg) };
  w.__escapeHtml = (s: unknown) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  w.__setTooltip = () => {};
  w.__onMessage = (type: string, handler: (msg: any) => void) => inbound.set(type, handler);
  w.__registerFeature = (id: string, handlers: Record<string, () => void>) => {
    featureHandlers[id] = Object.fromEntries(
      Object.entries(handlers).map(([name, fn]) => [name, () => act(() => fn())]),
    );
  };
  w.__orgConnected = true;
  w.__currentOrg = { sandboxName: null, isProtectedOrg: true };
  // Stashed, not invoked: the real one is an asynchronous native modal.
  w.__confirmIfSensitive = (_org: any, _label: string, onConfirmed: () => void) => {
    pendingConfirms.push(onConfirmed);
  };
  w.__confirmAction = (_prompt: string, onConfirmed: () => void) => onConfirmed();
  w.__newApexScript = (code: string) => newScripts.push(code);
  // jsdom has no layout, so no scrollIntoView — the viewer's jump-to-line calls it.
  Element.prototype.scrollIntoView = () => {};
}

async function mount() {
  // @ts-expect-error -- Vite's `?raw` import; the webview tsconfig carries no vite/client types.
  const html: string = (await import('../view.html?raw')).default;
  document.body.innerHTML = html;
  vi.resetModules();
  await import('./index');
}

const $ = <T extends Element>(sel: string) => document.querySelector(sel) as T;
const $$ = (sel: string) => Array.from(document.querySelectorAll(sel));

function btnByText(text: string): HTMLButtonElement {
  const found = $$('button').find((b) => (b.textContent || '').trim().startsWith(text));
  if (!found) throw new Error(`No button starting with "${text}"`);
  return found as HTMLButtonElement;
}

const editor = () => $<HTMLTextAreaElement>('.apex-editor');
const pills = () => $$('.query-tab') as HTMLElement[];
const outcome = () => $<HTMLElement>('.apex-outcome');
const viewerCard = () => document.getElementById('apex-viewer-card') as HTMLElement;

function setValue(el: HTMLTextAreaElement | HTMLSelectElement, value: string) {
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

const postsOf = (type: string) => posts.filter((p) => p.type === type);
const lastPost = (type: string) => {
  const all = postsOf(type);
  return all.length ? all[all.length - 1] : undefined;
};

function loadEmptyState(presetId = 'balanced') {
  deliver('apexStateLoaded', { tabs: [], activeTab: 0, history: [], savedSnippets: [], presetId });
}

/** Type `code`, click Execute, answer the sensitive-org modal; returns the opId. */
function execute(code: string): string {
  setValue(editor(), code);
  click(btnByText('▶ Execute'));
  act(() => pendingConfirms.shift()!());
  return lastPost('executeAnonymousApex')!.opId;
}

const LOG =
  '65.0 APEX_CODE,DEBUG\n' +
  '12:00:00.0 (1)|USER_DEBUG|[1]|DEBUG|hello\n' +
  '12:00:00.0 (2)|SOQL_EXECUTE_BEGIN|[2]|Aggregations:0|SELECT Id FROM Account\n';

const okOutcome = (opId: string, over: Post = {}) => ({
  opId,
  compiled: true,
  success: true,
  compileProblem: null,
  line: null,
  column: null,
  exceptionMessage: null,
  exceptionStackTrace: null,
  log: {
    body: LOG,
    partial: false,
    totalLines: 3,
    header: null,
    events: [
      { lineNo: 1, raw: '65.0 APEX_CODE,DEBUG', event: '', fields: [] },
      { lineNo: 2, raw: '12:00:00.0 (1)|USER_DEBUG|[1]|DEBUG|hello', event: 'USER_DEBUG' },
      { lineNo: 3, raw: '12:00:00.0 (2)|SOQL_EXECUTE_BEGIN|…', event: 'SOQL_EXECUTE_BEGIN' },
    ],
    summary: { counts: { soql: 1, dml: 0, rows: 0, callouts: 0, userDebug: 1 }, limits: [] },
    issues: [],
    tree: [],
    queryPlans: [],
  },
  ...over,
});

describe('▶️ Apex tab flow', () => {
  beforeEach(installGlobals);
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('boots by asking the host for persisted state, on one tab', async () => {
    await mount();
    expect(postsOf('loadApexState')).toHaveLength(1);
    expect(pills()).toHaveLength(1);
  });

  it('always goes through the sensitive-org gate, and sends the code captured at click time', async () => {
    await mount();
    loadEmptyState('soql-deep-dive');

    setValue(editor(), "insert new Account(Name = 'A');");
    click(btnByText('▶ Execute'));
    expect(postsOf('executeAnonymousApex')).toHaveLength(0);

    // The user moves on while the modal is up.
    click(btnByText('+'));
    setValue(editor(), 'delete [SELECT Id FROM Account];');
    act(() => pendingConfirms[0]());

    expect(lastPost('executeAnonymousApex')).toMatchObject({
      code: "insert new Account(Name = 'A');",
      presetId: 'soql-deep-dive',
    });
    expect(postsOf('operationStarted')).toHaveLength(1);
  });

  it('lands a result in the tab that ran it, not the one active when it arrives', async () => {
    await mount();
    loadEmptyState();

    const opId = execute('System.debug(UserInfo.getUserName());');
    click(btnByText('+'));
    deliver('anonymousApexExecuted', okOutcome(opId));

    expect(outcome()).toBeNull();
    expect(viewerCard().style.display).toBe('none');

    click(pills()[0].querySelector('.query-tab-label')!);
    expect(outcome()?.textContent).toContain('Executed successfully');
    expect(viewerCard().style.display).toBe('');
  });

  it('records history from the code AS SENT, not as the editor holds it at reply time', async () => {
    await mount();
    loadEmptyState();

    const opId = execute('System.debug(1);');
    setValue(editor(), 'System.debug(2);');
    deliver('anonymousApexExecuted', okOutcome(opId));

    expect(lastPost('addApexHistory')).toMatchObject({ code: 'System.debug(1);' });
  });

  it('drops a reply whose tab was closed — but still ends the operation', async () => {
    await mount();
    loadEmptyState();

    const opId = execute('System.debug(1);');
    click(btnByText('+'));
    click($('.query-tab .query-tab-close'));

    posts.length = 0;
    deliver('anonymousApexExecuted', okOutcome(opId));

    expect(postsOf('addApexHistory')).toHaveLength(0);
    expect(postsOf('operationEnded').some((p) => p.opId === opId)).toBe(true);
  });

  it('offers Log / Tree / Queries, and a None chip that clears every filter', async () => {
    await mount();
    loadEmptyState();
    deliver('anonymousApexExecuted', okOutcome(execute('System.debug(1);')));

    const modes = $$('#apex-mode-seg .dbg-seg-btn').map((b) => b.textContent);
    expect(modes).toEqual(['Log', 'Tree', 'Queries']);

    const chips = () => $$('#apex-chips .dbg-chip') as HTMLElement[];
    const chip = (label: string) => chips().find((c) => c.textContent === label)!;
    const hideNoise = $<HTMLInputElement>('#apex-hide-noise');

    // None leads the row, and is not lit while Hide noise (default on) is filtering.
    expect(chips()[0].textContent).toBe('None');
    expect(chip('None').classList.contains('active')).toBe(false);

    click(chip('SOQL / SOSL'));
    expect(chip('SOQL / SOSL').classList.contains('active')).toBe(true);
    expect(document.querySelectorAll('#apex-log-output .dbg-line')).toHaveLength(1);

    click(chip('None'));
    expect(hideNoise.checked).toBe(false);
    expect(chip('SOQL / SOSL').classList.contains('active')).toBe(false);
    expect(chip('None').classList.contains('active')).toBe(true);
    expect(document.querySelectorAll('#apex-log-output .dbg-line')).toHaveLength(3);

    // Re-ticking Hide noise means something is filtering again, so None goes dark.
    click(hideNoise);
    expect(chip('None').classList.contains('active')).toBe(false);
  });

  it('clears the filters when a search jump targets a line they hide', async () => {
    await mount();
    loadEmptyState();
    deliver('anonymousApexExecuted', okOutcome(execute('System.debug(1);')));

    const chip = (label: string) =>
      ($$('#apex-chips .dbg-chip') as HTMLElement[]).find((c) => c.textContent === label)!;
    click(chip('SOQL / SOSL'));
    expect(document.querySelectorAll('#apex-log-output .dbg-line')).toHaveLength(1);

    // "hello" is the USER_DEBUG line, which the SOQL chip is hiding.
    setValue($<HTMLInputElement>('#apex-log-search') as never, 'hello');

    expect(chip('SOQL / SOSL').classList.contains('active')).toBe(false);
    expect(chip('None').classList.contains('active')).toBe(true);
    expect(document.querySelector('#apex-log-output [data-line="2"]')).not.toBeNull();
  });

  it('keeps the filters when the jump target is already visible', async () => {
    await mount();
    loadEmptyState();
    deliver('anonymousApexExecuted', okOutcome(execute('System.debug(1);')));

    const chip = (label: string) =>
      ($$('#apex-chips .dbg-chip') as HTMLElement[]).find((c) => c.textContent === label)!;
    click(chip('USER_DEBUG'));
    setValue($<HTMLInputElement>('#apex-log-search') as never, 'hello');

    expect(chip('USER_DEBUG').classList.contains('active')).toBe(true);
    expect(chip('None').classList.contains('active')).toBe(false);
  });

  it('shows a compile error with its position, and Go to line selects that line', async () => {
    await mount();
    loadEmptyState();

    const code = 'Integer a = 1;\nInteger b = ;\nSystem.debug(a);';
    const opId = execute(code);
    deliver(
      'anonymousApexExecuted',
      okOutcome(opId, {
        compiled: false,
        success: false,
        compileProblem: "Unexpected token ';'.",
        line: 2,
        column: 13,
        log: null,
      }),
    );

    expect(outcome().textContent).toContain('Compile error — line 2, column 13');
    click(btnByText('Go to line 2'));
    const el = editor();
    expect(code.slice(el.selectionStart, el.selectionEnd)).toBe(';');
  });

  it('shows an uncaught exception with its stack, and still the log', async () => {
    await mount();
    loadEmptyState();

    const opId = execute('Integer x = 1 / 0;');
    deliver(
      'anonymousApexExecuted',
      okOutcome(opId, {
        success: false,
        exceptionMessage: 'System.MathException: Divide by 0',
        exceptionStackTrace: 'AnonymousBlock: line 1, column 1',
      }),
    );

    expect(outcome().textContent).toContain('Divide by 0');
    expect(outcome().textContent).toContain('AnonymousBlock: line 1');
    expect(viewerCard().style.display).toBe('');
  });

  it('cancels honestly: the op is ended, the tab says it may still complete, a late reply is dropped', async () => {
    await mount();
    loadEmptyState();

    const opId = execute('System.debug(1);');
    click(btnByText('✕ Cancel'));

    expect(postsOf('cancelOperation').some((p) => p.opId === opId)).toBe(true);
    expect(outcome().textContent).toContain('may still complete on the server');

    deliver('anonymousApexExecuted', okOutcome(opId));
    expect(outcome().textContent).toContain('may still complete on the server');
    expect(postsOf('addApexHistory')).toHaveLength(0);
  });

  it('applies the persisted preset and persists a new pick', async () => {
    await mount();
    loadEmptyState('user-debug-only');

    const select = $<HTMLSelectElement>('.apex-preset');
    expect(select.value).toBe('user-debug-only');
    setValue(select, 'deep-trace');
    expect(lastPost('saveApexPreset')).toMatchObject({ presetId: 'deep-trace' });
  });

  it('refuses to run blank code or with no org, without posting', async () => {
    await mount();
    loadEmptyState();

    click(btnByText('▶ Execute'));
    expect(outcome().textContent).toContain('Write some Apex');

    w.__orgConnected = false;
    setValue(editor(), 'System.debug(1);');
    click(btnByText('▶ Execute'));
    expect(outcome().textContent).toContain('Not connected');
    expect(pendingConfirms).toHaveLength(0);
  });

  it('names a tab after the first meaningful identifier', async () => {
    await mount();
    loadEmptyState();

    setValue(editor(), 'System.debug(UserInfo.getUserName());');
    expect(pills()[0].textContent).toContain('UserInfo');
  });

  it('hands the snippet to the Scripts form on Save as script', async () => {
    await mount();
    loadEmptyState();

    setValue(editor(), 'System.debug(42);');
    click(btnByText('📜 Save as script'));
    expect(newScripts).toEqual(['System.debug(42);']);
  });

  it('stops every run on either org edge', async () => {
    await mount();
    loadEmptyState();

    const opId = execute('System.debug(1);');
    featureHandlers['anonymous-apex'].onOrgConnected();

    expect(postsOf('cancelOperation').some((p) => p.opId === opId)).toBe(true);
    expect(btnByText('▶ Execute').disabled).toBe(false);
  });
});

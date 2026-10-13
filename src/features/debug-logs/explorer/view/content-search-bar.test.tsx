// @vitest-environment jsdom
//
// "Search inside logs" drives the list through its real seams: the filter box,
// the posted batches, the host replies and the rows the list then shows.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createContentSearchBar } from './content-search-bar';
import { createLogList } from './log-list';

const LIST_IDS: [string, string][] = [
  ['dbg-log-filter', 'input'],
  ['dbg-log-count', 'span'],
  ['dbg-errors-only', 'input'],
  ['dbg-hide-empty', 'input'],
  ['dbg-live-tail', 'input'],
  ['dbg-refresh-logs', 'button'],
  ['dbg-delete-selected', 'button'],
  ['dbg-delete-all', 'button'],
  ['dbg-hidden-chip', 'div'],
  ['dbg-log-thead', 'thead'],
  ['dbg-log-tbody', 'tbody'],
  ['dbg-list-empty', 'div'],
  ['dbg-list-status', 'span'],
  ['dbg-list-error', 'div'],
  ['dbg-content-search-cancel', 'button'],
  ['dbg-content-search-status', 'span'],
];

const LABELS = {
  columns: ['Time', 'User', 'Operation', 'Status', 'Duration', 'Size', 'Request'],
  deleteSelected: () => 'Delete',
  deletingLogs: () => 'Deleting',
  checkingContents: 'Checking',
  hiddenAsEmpty: () => 'hidden',
  noLogs: 'none',
  notConnected: 'offline',
  show: 'Show',
  searchHint: 'hint',
  searchProgress: (s: number, t: number, m: number) => `progress ${s}/${t} ${m}`,
  searchDone: (m: number, t: number) => `done ${m}/${t}`,
  searchStopped: (s: number, t: number, m: number) => `stopped ${s}/${t} ${m}`,
  searchFailed: (msg: string) => `failed ${msg}`,
  searchNotScanned: (n: number) => `${n} new`,
  matchLines: (n: number) => `${n} lines`,
};

const row = (id: string, operation: string) => ({
  id,
  startTime: '2026-10-13T10:00:00.000Z',
  logUserName: 'Pablo',
  operation,
  status: 'Success',
  durationMilliseconds: 1,
  logLength: 10,
  request: 'Api',
});

function setup(logCount = 3) {
  document.body.innerHTML = '';
  for (const [id, tag] of LIST_IDS) {
    const el = document.createElement(tag);
    el.id = id;
    document.body.appendChild(el);
  }
  let logs = Array.from({ length: logCount }, (_, i) => row(`07L${i}`, `Op${i}`));
  const posted: any[] = [];
  const vscode = { postMessage: vi.fn((msg: any) => posted.push(msg)) };
  const onOpenLog = vi.fn();
  // Same construction order as view/index.js.
  const bar = createContentSearchBar({
    labels: LABELS,
    vscode,
    getConnected: () => true,
    getLogIds: () => logs.map((l) => l.id),
    onChange: () => list.refresh(),
  });
  const list = createLogList({
    labels: LABELS,
    vscode,
    escapeHtml: (s: string) => s,
    getConnected: () => true,
    getVisible: () => true,
    onOpenLog,
    onStateChange: vi.fn(),
    contentSearch: bar,
  });
  list.setLogs(logs);
  const setLogs = (next: typeof logs) => {
    logs = next;
    list.setLogs(logs);
    bar.paint();
  };
  return { bar, list, posted, onOpenLog, setLogs };
}

const filter = () => document.getElementById('dbg-log-filter') as HTMLInputElement;

/** Type into the list's filter box, as the user does (no Enter). */
function type(text: string) {
  filter().value = text;
  filter().dispatchEvent(new Event('input'));
}

/** Type, then press Enter — the only thing that searches inside the logs. */
function search(text: string) {
  type(text);
  filter().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
}

const searches = (posted: any[]) => posted.filter((m) => m.type === 'searchApexLogBodies');
const operations = () =>
  [...document.querySelectorAll('.dbg-log-row:not(.dbg-match-row)')].map(
    (tr) => tr.children[3].textContent,
  );
const status = () => document.getElementById('dbg-content-search-status')!.textContent;

describe('search inside logs', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('asks the host about the listed logs and narrows the rows to the matches', () => {
    const { bar, posted } = setup();
    search('REQUIRED_FIELD_MISSING');

    const [req] = searches(posted);
    expect(req).toMatchObject({
      query: 'REQUIRED_FIELD_MISSING',
      logIds: ['07L0', '07L1', '07L2'],
    });
    expect(posted.some((m) => m.type === 'operationStarted' && m.opId === req.opId)).toBe(true);
    expect(operations()).toEqual([]); // nothing has matched yet

    bar.onResult({
      opId: req.opId,
      matches: [{ id: '07L1', count: 2, firstLine: 'FATAL_ERROR|boom', firstLineNo: 42 }],
    });

    expect(operations()).toEqual(['Op1']);
    const match = document.querySelector('.dbg-match-row')!;
    expect(match.textContent).toContain('2 lines');
    expect(match.textContent).toContain('42: FATAL_ERROR|boom');
    expect(status()).toBe('done 1/3');
    expect(posted.some((m) => m.type === 'operationEnded' && m.opId === req.opId)).toBe(true);
  });

  it('keeps asking batch after batch until every listed log is scanned', () => {
    const { bar, posted } = setup(25);
    search('boom');
    const first = searches(posted)[0];
    expect(first.logIds).toHaveLength(20);

    bar.onResult({ opId: first.opId, matches: [] });
    const second = searches(posted)[1];
    expect(second.logIds).toEqual(['07L20', '07L21', '07L22', '07L23', '07L24']);
    expect(status()).toBe('progress 20/25 0');

    bar.onResult({ opId: second.opId, matches: [] });
    expect(searches(posted)).toHaveLength(2);
    expect(status()).toBe('done 0/25');
  });

  it('cancel stops asking, tells the host, and drops the late reply', () => {
    const { bar, posted } = setup(25);
    search('boom');
    const first = searches(posted)[0];

    (document.getElementById('dbg-content-search-cancel') as HTMLButtonElement).click();
    expect(posted.some((m) => m.type === 'cancelOperation' && m.opId === first.opId)).toBe(true);

    bar.onResult({
      opId: first.opId,
      matches: [{ id: '07L0', count: 1, firstLine: 'x', firstLineNo: 1 }],
    });
    expect(searches(posted)).toHaveLength(1);
    expect(operations()).toEqual([]);
    expect(status()).toBe('stopped 0/25 0');
  });

  it('a newer search drops the previous one’s reply', () => {
    const { bar, posted } = setup();
    search('first');
    const stale = searches(posted)[0];
    search('second');
    bar.onResult({
      opId: stale.opId,
      matches: [{ id: '07L0', count: 1, firstLine: 'x', firstLineNo: 1 }],
    });
    expect(operations()).toEqual([]);
    expect(searches(posted)[1].query).toBe('second');
  });

  it('a failed batch stops the search and says why', () => {
    const { bar, posted } = setup();
    search('boom');
    bar.onError({ opId: searches(posted)[0].opId, message: 'INVALID_SESSION_ID' });
    expect(status()).toBe('failed INVALID_SESSION_ID');
  });

  it('typing filters the columns only and never asks the host', () => {
    const { posted } = setup();
    type('Op1');
    expect(operations()).toEqual(['Op1']);
    expect(searches(posted)).toHaveLength(0);
    expect(status()).toBe('hint');
  });

  it('after Enter a row shows if its columns OR its content match', () => {
    const { bar, posted } = setup();
    search('Op1');
    bar.onResult({
      opId: searches(posted)[0].opId,
      matches: [{ id: '07L2', count: 1, firstLine: 'calls Op1', firstLineNo: 9 }],
    });
    expect(operations()).toEqual(['Op1', 'Op2']);
    expect(document.querySelectorAll('.dbg-match-row')).toHaveLength(1);
  });

  it('editing the text drops the content results and stops a running sweep', () => {
    const { bar, posted } = setup(25);
    search('boom');
    const first = searches(posted)[0];
    bar.onResult({
      opId: first.opId,
      matches: [{ id: '07L0', count: 1, firstLine: 'boom', firstLineNo: 1 }],
    });
    expect(operations()).toEqual(['Op0']);
    const running = searches(posted)[1];

    type('boo');
    expect(posted.some((m) => m.type === 'cancelOperation' && m.opId === running.opId)).toBe(true);
    expect(bar.getQuery()).toBe('');
    expect(operations()).toEqual([]); // 'boo' matches no column
    expect(status()).toBe('hint');

    type('');
    expect(operations()).toHaveLength(25);
  });

  it('Enter on a blank box asks the host nothing', () => {
    const { posted } = setup();
    search('   ');
    expect(searches(posted)).toHaveLength(0);
  });

  it('says when tailed logs arrived after the search', () => {
    const { bar, posted, setLogs } = setup(1);
    search('boom');
    bar.onResult({ opId: searches(posted)[0].opId, matches: [] });
    setLogs([row('07Lnew', 'New'), row('07L0', 'Op0')]);
    expect(status()).toBe('done 0/1 · 1 new');
  });

  it('opens a log from its match line', () => {
    const { bar, posted, onOpenLog } = setup();
    search('boom');
    bar.onResult({
      opId: searches(posted)[0].opId,
      matches: [{ id: '07L2', count: 1, firstLine: 'x', firstLineNo: 1 }],
    });
    (document.querySelector('.dbg-match-row') as HTMLElement).click();
    expect(onOpenLog).toHaveBeenCalledWith('07L2');
  });

  it('reset (org change) forgets the search', () => {
    const { bar, posted } = setup();
    search('boom');
    bar.reset();
    expect(bar.getQuery()).toBe('');
    expect(posted.some((m) => m.type === 'cancelOperation')).toBe(true);
    expect(filter().value).toBe('boom'); // the list's filter text is kept
  });
});

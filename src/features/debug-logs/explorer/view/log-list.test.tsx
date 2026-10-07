// @vitest-environment jsdom
//
// An org switch connects straight to the new org with no disconnect in between,
// so the list's reset() is the only thing that drops the previous org's error
// and status line. It once cleared the rows but left both on screen.
import { describe, expect, it, vi } from 'vitest';

const { createLogList } = await import('./log-list');

const IDS = [
  'dbg-log-filter',
  'dbg-log-count',
  'dbg-errors-only',
  'dbg-hide-empty',
  'dbg-live-tail',
  'dbg-refresh-logs',
  'dbg-delete-selected',
  'dbg-delete-all',
  'dbg-hidden-chip',
  'dbg-log-thead',
  'dbg-log-tbody',
  'dbg-list-empty',
  'dbg-list-status',
  'dbg-list-error',
];
const INPUTS = new Set(['dbg-log-filter', 'dbg-errors-only', 'dbg-hide-empty', 'dbg-live-tail']);
const BUTTONS = new Set(['dbg-refresh-logs', 'dbg-delete-selected', 'dbg-delete-all']);

const LABELS = {
  columns: ['A', 'B'],
  deleteSelected: () => 'Delete',
  deletingLogs: () => 'Deleting',
  checkingContents: 'Checking',
  hiddenAsEmpty: () => 'hidden',
  noLogs: 'none',
  notConnected: 'offline',
  show: 'Show',
};

function setup() {
  document.body.innerHTML = '';
  for (const id of IDS) {
    const el = document.createElement(
      INPUTS.has(id) ? 'input' : BUTTONS.has(id) ? 'button' : 'div',
    );
    el.id = id;
    document.body.appendChild(el);
  }
  return createLogList({
    labels: LABELS,
    vscode: { postMessage: vi.fn() },
    escapeHtml: (s: string) => s,
    getConnected: () => true,
    getVisible: () => true,
    onOpenLog: vi.fn(),
    onStateChange: vi.fn(),
  });
}

describe('log list reset', () => {
  it('drops the previous org’s error and status line', () => {
    const list = setup();
    list.showError('INVALID_SESSION_ID');
    document.getElementById('dbg-list-status')!.textContent = 'Checking logs…';

    list.reset();

    const error = document.getElementById('dbg-list-error')!;
    expect(error.style.display).toBe('none');
    expect(document.getElementById('dbg-list-status')!.textContent).toBe('');
  });
});

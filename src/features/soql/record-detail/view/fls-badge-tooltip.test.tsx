// @vitest-environment jsdom
// The 🔒 badge's tooltip through the REAL media/modules/tooltip.js, not a stub.
//
// record-detail.test.tsx stubs `__setTooltip`, so it can only check what the
// badge ASKED for — and it happily asserted the `data-tooltip-wrap` opt-in that
// was silently suppressing the tooltip: tooltip.js used to show a wrap tooltip
// only when the target itself was clipped, and a badge never is. Only the real
// module, driven by a real mouseover, can see whether anything appears.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup } from '@testing-library/preact';
import type { RecordDetailData } from '../../../../shared/protocol';
import '../labels.js';
// The real module: installs the delegated hover listeners and the real
// __setTooltip. Imported once — re-importing per test would stack listeners.
import '../../../../../media/modules/tooltip.js';

const w = window as unknown as Record<string, any>;
const ID = '001000000000001AAA';
let inbound: Map<string, (msg: any) => void>;
let posts: Array<Record<string, any>>;

function installGlobals() {
  inbound = new Map();
  posts = [];
  w.__vscode = { postMessage: (msg: Record<string, any>) => posts.push(msg) };
  w.__activateTab = () => {};
  w.__activateSubTab = () => {};
  w.__onMessage = (type: string, handler: (msg: any) => void) => inbound.set(type, handler);
  w.__registerFeature = () => {};
  w.__orgConnected = true;
  w.__confirmAction = (_p: string, ok: () => void) => ok();
}

const record: RecordDetailData = {
  objectName: 'Account',
  objectLabel: 'Account',
  id: ID,
  fields: [
    {
      name: 'Rating',
      label: 'Rating',
      type: 'picklist',
      referenceTo: [],
      picklistValues: ['Hot'],
      inlineHelpText: null,
      required: false,
      custom: false,
      unique: false,
      externalId: false,
      filterable: true,
      sortable: true,
      groupable: true,
      permissionable: true,
    },
  ],
  values: { Rating: 'Hot' },
  access: {
    Rating: { kind: 'readOnly', grantedBy: ['Sales_Ops (Permission Set)'] },
    Secret__c: { kind: 'hidden', grantedBy: [] },
  },
  hiddenFields: [{ name: 'Secret__c', label: 'Secret', type: 'Text(80)' }],
};

describe('🔒 badge tooltip (real tooltip.js)', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    installGlobals();
    // Append rather than reset <body>: tooltip.js keeps a handle on its own
    // tooltip element there, and wiping the body would detach it for good.
    const root = document.createElement('div');
    root.id = 'record-detail-root';
    document.body.appendChild(root);
    vi.resetModules();
    await import('./index');
    // A real load, so the reply carries the opId the controller is waiting on.
    act(() => w.__showRecordDetail(ID));
    const { opId } = posts.find((p) => p.type === 'loadRecordDetail') as { opId: string };
    act(() =>
      inbound.get('recordDetailLoaded')?.({
        type: 'recordDetailLoaded',
        data: { ...record, opId },
      }),
    );
  });
  afterEach(() => {
    cleanup();
    // tooltip.js hides — and forgets its current target — on any click.
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document.getElementById('record-detail-root')?.remove();
    vi.useRealTimers();
  });

  function hover(el: Element): HTMLElement | null {
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    vi.advanceTimersByTime(500); // past tooltip.js's 400 ms show delay
    return document.querySelector('.fc-tooltip.fc-tooltip--visible');
  }

  const badges = () => Array.from(document.querySelectorAll('.rec-detail-fls-badge'));

  it('shows the read-only explanation, wrapped, on hover', () => {
    const badge = badges().find((b) => b.textContent === '🔒 No edit access') as Element;
    const tip = hover(badge);

    expect(tip?.textContent).toBe(
      'Field-level security makes this field read-only for you. ' +
        'Edit is granted by: Sales_Ops (Permission Set).',
    );
    expect(tip?.classList.contains('fc-tooltip--wrap')).toBe(true);
  });

  it('shows the hidden-field explanation on hover', () => {
    const badge = badges().find((b) => b.textContent === '🔒 No read access') as Element;

    expect(hover(badge)?.textContent).toContain('Field-level security hides this field from you');
  });
});

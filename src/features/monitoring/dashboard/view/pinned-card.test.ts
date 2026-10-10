// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createPinnedCards, isPinReply } from './pinned-card';

function setup(opts: { connected?: boolean; visible?: boolean; configs?: any[] } = {}) {
  const grid = document.createElement('div');
  const open = document.createElement('div');
  open.className = 'monitoring-edit-form';
  grid.appendChild(open);
  const configs = opts.configs ?? [];
  const state = { connected: opts.connected ?? true, visible: opts.visible ?? true };
  const triggerQuery = vi.fn();
  const afterInsert = vi.fn();
  const pins = createPinnedCards({
    grid,
    getConfigs: () => configs,
    buildViewCard: (cfg) => {
      const card = document.createElement('div');
      card.dataset.configId = cfg.id;
      return card;
    },
    triggerQuery,
    getConnected: () => state.connected,
    isPanelVisible: () => state.visible,
    afterInsert,
  });
  return { grid, open, configs, state, triggerQuery, afterInsert, pins };
}

const saved = { id: 'soql/pipeline', name: 'Pipeline', chartType: 'bar' };

describe('isPinReply', () => {
  it('recognises only the soql-pin origin', () => {
    expect(isPinReply({ origin: 'soql-pin' })).toBe(true);
    expect(isPinReply({ requestId: 'mon-1' })).toBe(false);
    expect(isPinReply(undefined)).toBe(false);
  });
});

describe('createPinnedCards', () => {
  it('appends one card and leaves an open edit form in the grid', () => {
    const { grid, open, configs, afterInsert, pins } = setup();
    pins.insert(saved);
    expect(configs).toEqual([saved]);
    expect(grid.contains(open)).toBe(true);
    expect(grid.querySelectorAll('[data-config-id="soql/pipeline"]')).toHaveLength(1);
    expect(afterInsert).toHaveBeenCalledOnce();
  });

  it('queries at once when the panel is visible', () => {
    const { triggerQuery, pins } = setup({ visible: true });
    pins.insert(saved);
    expect(triggerQuery).toHaveBeenCalledWith(saved);
  });

  it('defers the query while the panel is hidden, then runs it once on flush', () => {
    const { triggerQuery, pins } = setup({ visible: false });
    pins.insert(saved);
    expect(triggerQuery).not.toHaveBeenCalled();
    pins.flushPending();
    pins.flushPending();
    expect(triggerQuery).toHaveBeenCalledTimes(1);
  });

  it('a full rebuild clears what was owed', () => {
    const { triggerQuery, pins } = setup({ visible: false });
    pins.insert(saved);
    pins.clearPending();
    pins.flushPending();
    expect(triggerQuery).not.toHaveBeenCalled();
  });

  it('queries nothing while disconnected', () => {
    const { triggerQuery, pins, state } = setup({ connected: false, visible: false });
    pins.insert(saved);
    state.connected = false;
    pins.flushPending();
    expect(triggerQuery).not.toHaveBeenCalled();
  });

  it('ignores a record whose id is already in the grid', () => {
    const { grid, configs, pins } = setup({ configs: [{ ...saved }] });
    pins.insert(saved);
    expect(configs).toHaveLength(1);
    expect(grid.querySelectorAll('[data-config-id]')).toHaveLength(0);
  });
});

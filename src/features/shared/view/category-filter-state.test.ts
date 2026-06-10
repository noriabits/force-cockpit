import { describe, it, expect } from 'vitest';
import {
  createCategoryFilterState,
  topLevelFolders,
  subFoldersOf,
  FilterItem,
} from './category-filter-state';

const items: FilterItem[] = [
  { id: 'a', folder: 'orders', source: 'builtin' },
  { id: 'b', folder: 'orders/advanced', source: 'user' },
  { id: 'c', folder: 'orders/basic', source: 'private' },
  { id: 'd', folder: 'users', source: 'user' },
  { id: 'e', folder: 'misc', source: 'private' },
];

describe('topLevelFolders', () => {
  it('dedupes, sorts, and extracts top-level segments', () => {
    expect(topLevelFolders(['orders/advanced', 'orders', 'users', 'misc', 'orders/basic'])).toEqual(
      ['misc', 'orders', 'users'],
    );
  });

  it('returns empty array for empty input', () => {
    expect(topLevelFolders([])).toEqual([]);
  });
});

describe('subFoldersOf', () => {
  it('extracts unique sorted child segments of the parent', () => {
    expect(
      subFoldersOf(['orders', 'orders/basic', 'orders/advanced', 'orders/basic'], 'orders'),
    ).toEqual(['advanced', 'basic']);
  });

  it('does not match folders that merely share a prefix', () => {
    expect(subFoldersOf(['orders-x/sub', 'orders'], 'orders')).toEqual([]);
  });
});

describe('matchesVisibility', () => {
  it("'all' passes everything", () => {
    const state = createCategoryFilterState();
    expect(items.every((i) => state.matchesVisibility(i))).toBe(true);
  });

  it("'shared' accepts user and builtin, rejects private", () => {
    const state = createCategoryFilterState();
    state.setVisibility('shared');
    expect(state.matchesVisibility({ folder: 'x', source: 'user' })).toBe(true);
    expect(state.matchesVisibility({ folder: 'x', source: 'builtin' })).toBe(true);
    expect(state.matchesVisibility({ folder: 'x', source: 'private' })).toBe(false);
  });

  it("'private' accepts only private", () => {
    const state = createCategoryFilterState();
    state.setVisibility('private');
    expect(state.matchesVisibility({ folder: 'x', source: 'private' })).toBe(true);
    expect(state.matchesVisibility({ folder: 'x', source: 'user' })).toBe(false);
  });

  it("'favorites' delegates to isFavorite", () => {
    const favs = new Set(['a']);
    const state = createCategoryFilterState({ isFavorite: (i) => favs.has(i.id ?? '') });
    state.setVisibility('favorites');
    expect(state.matchesVisibility({ id: 'a', folder: 'x', source: 'user' })).toBe(true);
    expect(state.matchesVisibility({ id: 'b', folder: 'x', source: 'user' })).toBe(false);
  });

  it("'favorites' without isFavorite matches nothing", () => {
    const state = createCategoryFilterState();
    state.setVisibility('favorites');
    expect(state.matchesVisibility({ id: 'a', folder: 'x', source: 'user' })).toBe(false);
  });
});

describe('matchesFolder', () => {
  it("'all' matches any folder", () => {
    const state = createCategoryFilterState();
    expect(state.matchesFolder('anything')).toBe(true);
  });

  it('top-level folder matches exact and nested, but not prefix-similar names', () => {
    const state = createCategoryFilterState();
    state.setFolder('orders');
    expect(state.matchesFolder('orders')).toBe(true);
    expect(state.matchesFolder('orders/advanced')).toBe(true);
    expect(state.matchesFolder('orders-x')).toBe(false);
    expect(state.matchesFolder('users')).toBe(false);
  });

  it('subFolder matches the exact full path only', () => {
    const state = createCategoryFilterState();
    state.setFolder('orders');
    state.setSubFolder('advanced');
    expect(state.matchesFolder('orders/advanced')).toBe(true);
    expect(state.matchesFolder('orders')).toBe(false);
    expect(state.matchesFolder('orders/basic')).toBe(false);
  });
});

describe('state transitions', () => {
  it('setVisibility resets folder and subFolder', () => {
    const state = createCategoryFilterState();
    state.setFolder('orders');
    state.setSubFolder('advanced');
    state.setVisibility('private');
    expect(state.getState()).toEqual({ visibility: 'private', folder: 'all', subFolder: null });
  });

  it('setFolder resets subFolder', () => {
    const state = createCategoryFilterState();
    state.setFolder('orders');
    state.setSubFolder('advanced');
    state.setFolder('users');
    expect(state.getState()).toEqual({ visibility: 'all', folder: 'users', subFolder: null });
  });

  it('setSubFolder normalizes a bare segment to the full path', () => {
    const state = createCategoryFilterState();
    state.setFolder('orders');
    state.setSubFolder('advanced');
    expect(state.getState().subFolder).toBe('orders/advanced');
  });

  it('setSubFolder accepts a full path as-is', () => {
    const state = createCategoryFilterState();
    state.setFolder('orders');
    state.setSubFolder('orders/advanced');
    expect(state.getState().subFolder).toBe('orders/advanced');
  });

  it('reset returns to defaults', () => {
    const state = createCategoryFilterState();
    state.setVisibility('private');
    state.setFolder('orders');
    state.reset();
    expect(state.getState()).toEqual({ visibility: 'all', folder: 'all', subFolder: null });
  });
});

describe('reconcile', () => {
  const folders = ['orders', 'orders/advanced', 'users'];

  it('falls back to all when the desired folder is absent', () => {
    const state = createCategoryFilterState();
    state.setState({ folder: 'gone', subFolder: 'gone/sub' });
    expect(state.reconcile(folders)).toEqual({
      visibility: 'all',
      folder: 'all',
      subFolder: null,
    });
  });

  it('keeps the folder but drops an absent subFolder', () => {
    const state = createCategoryFilterState();
    state.setState({ folder: 'orders', subFolder: 'orders/gone' });
    expect(state.reconcile(folders)).toEqual({
      visibility: 'all',
      folder: 'orders',
      subFolder: null,
    });
  });

  it('fully restores folder + subFolder when both exist (post-save contract)', () => {
    const state = createCategoryFilterState();
    state.setState({ folder: 'orders', subFolder: 'orders/advanced' });
    expect(state.reconcile(folders)).toEqual({
      visibility: 'all',
      folder: 'orders',
      subFolder: 'orders/advanced',
    });
  });

  it('matches a folder that only exists as a parent of nested folders', () => {
    const state = createCategoryFilterState();
    state.setState({ folder: 'orders' });
    expect(state.reconcile(['orders/advanced']).folder).toBe('orders');
  });

  it('drops a subFolder that is not under the active folder', () => {
    const state = createCategoryFilterState();
    state.setState({ folder: 'users', subFolder: 'orders/advanced' });
    expect(state.reconcile(folders).subFolder).toBe(null);
  });
});

describe('visibleItems / foldersOf / isFiltered', () => {
  it('visibleItems filters by visibility only', () => {
    const state = createCategoryFilterState();
    state.setVisibility('private');
    state.setFolder('orders'); // ignored by visibleItems
    expect(state.visibleItems(items).map((i) => i.id)).toEqual(['c', 'e']);
  });

  it('foldersOf returns unique sorted folders of visible items', () => {
    const state = createCategoryFilterState();
    state.setVisibility('shared');
    expect(state.foldersOf(items)).toEqual(['orders', 'orders/advanced', 'users']);
  });

  it('matches combines visibility and folder', () => {
    const state = createCategoryFilterState();
    state.setVisibility('shared');
    state.setFolder('orders');
    expect(state.matches({ folder: 'orders/advanced', source: 'user' })).toBe(true);
    expect(state.matches({ folder: 'orders/basic', source: 'private' })).toBe(false);
    expect(state.matches({ folder: 'users', source: 'user' })).toBe(false);
  });

  it('isFiltered truth table', () => {
    const state = createCategoryFilterState();
    expect(state.isFiltered()).toBe(false);
    state.setVisibility('shared');
    expect(state.isFiltered()).toBe(true);
    state.reset();
    state.setFolder('orders');
    expect(state.isFiltered()).toBe(true);
    state.setSubFolder('advanced');
    expect(state.isFiltered()).toBe(true);
    state.reset();
    expect(state.isFiltered()).toBe(false);
  });
});

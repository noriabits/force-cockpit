/**
 * Pure state core for the category/visibility filter bar shared by the
 * yaml-scripts and monitoring dashboard webviews. No DOM access — the DOM
 * layer lives in category-filter-bar.js. `subFolder` is always stored as a
 * full path ('parent/sub').
 *
 * `setState` records *desired* state without validation; `reconcile` validates
 * it against the folders actually present at render time. They are split
 * because post-save flows select a folder that only exists in the *next*
 * item list.
 */

export interface FilterItem {
  folder: string;
  source: string;
  id?: string;
}

export interface FilterStateSnapshot {
  visibility: string;
  folder: string;
  subFolder: string | null;
}

export interface CategoryFilterState {
  getState(): FilterStateSnapshot;
  setVisibility(visibility: string): void;
  setFolder(folder: string): void;
  setSubFolder(subFolder: string | null): void;
  setState(partial: Partial<FilterStateSnapshot>): void;
  reconcile(availableFolders: string[]): FilterStateSnapshot;
  reset(): void;
  matchesVisibility(item: FilterItem): boolean;
  matchesFolder(folder: string): boolean;
  matches(item: FilterItem): boolean;
  visibleItems<T extends FilterItem>(items: T[]): T[];
  foldersOf(items: FilterItem[]): string[];
  isFiltered(): boolean;
}

/** Unique, sorted top-level segments of a folder list. */
export function topLevelFolders(folders: string[]): string[] {
  return [...new Set(folders.map((f) => f.split('/')[0]))].sort();
}

/** Unique, sorted child segments of `parent` within a folder list. */
export function subFoldersOf(folders: string[], parent: string): string[] {
  const subs = folders
    .filter((f) => f.startsWith(parent + '/'))
    .map((f) => f.slice(parent.length + 1));
  return [...new Set(subs)].sort();
}

export function createCategoryFilterState(opts?: {
  isFavorite?: (item: FilterItem) => boolean;
}): CategoryFilterState {
  const isFavorite = opts?.isFavorite;

  let visibility = 'all';
  let folder = 'all';
  let subFolder: string | null = null;

  function setSubFolder(sub: string | null): void {
    if (sub === null) {
      subFolder = null;
      return;
    }
    // Normalize bare child segments to full 'parent/sub' paths
    subFolder = sub.includes('/') || folder === 'all' ? sub : `${folder}/${sub}`;
  }

  return {
    getState: () => ({ visibility, folder, subFolder }),

    setVisibility(v) {
      visibility = v;
      folder = 'all';
      subFolder = null;
    },

    setFolder(f) {
      folder = f;
      subFolder = null;
    },

    setSubFolder,

    setState(partial) {
      if (partial.visibility !== undefined) visibility = partial.visibility;
      if (partial.folder !== undefined) folder = partial.folder;
      if (partial.subFolder !== undefined) setSubFolder(partial.subFolder);
    },

    reconcile(availableFolders) {
      if (folder !== 'all') {
        const folderExists = availableFolders.some(
          (f) => f === folder || f.startsWith(folder + '/'),
        );
        if (!folderExists) {
          folder = 'all';
          subFolder = null;
        }
      }
      if (subFolder !== null) {
        const valid =
          folder !== 'all' &&
          subFolder.startsWith(folder + '/') &&
          availableFolders.includes(subFolder);
        if (!valid) subFolder = null;
      }
      return { visibility, folder, subFolder };
    },

    reset() {
      visibility = 'all';
      folder = 'all';
      subFolder = null;
    },

    matchesVisibility(item) {
      if (visibility === 'private') return item.source === 'private';
      if (visibility === 'shared') return item.source !== 'private';
      if (visibility === 'favorites') return isFavorite ? isFavorite(item) : false;
      return true;
    },

    matchesFolder(f) {
      if (folder === 'all') return true;
      if (subFolder !== null) return f === subFolder;
      return f === folder || f.startsWith(folder + '/');
    },

    matches(item) {
      return this.matchesVisibility(item) && this.matchesFolder(item.folder);
    },

    visibleItems(items) {
      return items.filter((item) => this.matchesVisibility(item));
    },

    foldersOf(items) {
      return [...new Set(this.visibleItems(items).map((item) => item.folder))].sort();
    },

    isFiltered() {
      return visibility !== 'all' || folder !== 'all' || subFolder !== null;
    },
  };
}

// @ts-check
/**
 * DOM layer for the shared category/visibility filter bar. All branching
 * logic lives in the tested state core (category-filter-state.ts); this
 * module only builds buttons and keeps `.active` classes in sync.
 *
 * `render()` reconciles the desired state against the current items and
 * rebuilds the three button rows. It never fires `onChange` — that is
 * reserved for user clicks, so programmatic re-renders (e.g. after a list
 * reload) don't trigger redundant filter passes.
 */
import { createCategoryFilterState, topLevelFolders, subFoldersOf } from './category-filter-state';

/**
 * @param {{
 *   visibilityEl: HTMLElement,
 *   pillsEl: HTMLElement,
 *   subPillsEl: HTMLElement,
 *   visibilityOptions: Array<{ value: string, label: string }>,
 *   labels: { pillAll: string, pillSubAll: string },
 *   getItems: () => Array<{ folder: string, source: string, id?: string }>,
 *   isFavorite?: (item: { folder: string, source: string, id?: string }) => boolean,
 *   onChange: (state: { visibility: string, folder: string, subFolder: string | null }) => void,
 * }} opts
 */
export function createCategoryFilterBar(opts) {
  const { visibilityEl, pillsEl, subPillsEl, visibilityOptions, labels, getItems, onChange } = opts;
  const state = createCategoryFilterState({ isFavorite: opts.isFavorite });

  function notifyChange() {
    onChange(state.getState());
  }

  function renderVisibility() {
    const { visibility } = state.getState();
    visibilityEl.innerHTML = '';
    for (const opt of visibilityOptions) {
      const btn = document.createElement('button');
      btn.className = 'visibility-filter-btn' + (visibility === opt.value ? ' active' : '');
      btn.textContent = opt.label;
      btn.addEventListener('click', () => {
        if (state.getState().visibility === opt.value) return;
        state.setVisibility(opt.value);
        render();
        notifyChange();
      });
      visibilityEl.appendChild(btn);
    }
  }

  /** @param {string[]} folders */
  function renderPills(folders) {
    const { folder } = state.getState();
    pillsEl.innerHTML = '';

    /**
     * @param {string} label
     * @param {string} value
     */
    const makePill = (label, value) => {
      const btn = document.createElement('button');
      btn.className = 'category-pill' + (folder === value ? ' active' : '');
      btn.textContent = label;
      btn.addEventListener('click', () => {
        if (state.getState().folder === value) return;
        state.setFolder(value);
        render();
        notifyChange();
      });
      return btn;
    };

    pillsEl.appendChild(makePill(labels.pillAll, 'all'));
    for (const top of topLevelFolders(folders)) {
      pillsEl.appendChild(makePill(top, top));
    }
  }

  /** @param {string[]} folders */
  function renderSubPills(folders) {
    const { folder, subFolder } = state.getState();
    subPillsEl.innerHTML = '';
    const subs = folder === 'all' ? [] : subFoldersOf(folders, folder);
    if (subs.length === 0) {
      subPillsEl.classList.remove('visible');
      return;
    }
    subPillsEl.classList.add('visible');

    /**
     * @param {string} label
     * @param {string | null} value - full path or null for "All"
     */
    const makeSubPill = (label, value) => {
      const btn = document.createElement('button');
      btn.className = 'category-pill' + (subFolder === value ? ' active' : '');
      btn.textContent = label;
      btn.addEventListener('click', () => {
        if (state.getState().subFolder === value) return;
        state.setSubFolder(value);
        render();
        notifyChange();
      });
      return btn;
    };

    subPillsEl.appendChild(makeSubPill(labels.pillSubAll, null));
    for (const sub of subs) {
      subPillsEl.appendChild(makeSubPill(sub, `${folder}/${sub}`));
    }
  }

  function render() {
    const folders = state.foldersOf(getItems());
    state.reconcile(folders);
    renderVisibility();
    renderPills(folders);
    renderSubPills(folders);
  }

  return {
    getState: () => state.getState(),
    /** @param {{ folder: string, source: string, id?: string }} item */
    matches: (item) => state.matches(item),
    isFiltered: () => state.isFiltered(),
    /** @param {Partial<{ visibility: string, folder: string, subFolder: string | null }>} partial */
    setState: (partial) => state.setState(partial),
    render,
    reset: () => {
      state.reset();
      render();
    },
  };
}

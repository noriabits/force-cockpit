// Pure list-filter loop shared by the monitoring and yaml-scripts webviews.
// Both iterate rendered elements, read folder/source/search-text (and yaml-scripts
// also an id for the favorites filter), combine the shared filter-bar predicate
// with a case-insensitive substring text match, toggle `style.display`, and count
// the visible elements. Feature-specific concerns (no-results toggle, monitoring's
// drag-handle hiding, the custom display value) stay at each call site; this helper
// only owns the per-element visibility decision and returns the visible count.

/** Minimal element shape — keeps the helper DOM-free and unit-testable. */
export interface FilterableElement {
  getAttribute(name: string): string | null;
  style: { display: string };
}

/** Attributes read off one element for the filter decision. */
export interface ListFilterAttrs {
  folder: string;
  source: string;
  id?: string;
  searchText: string;
}

export interface ApplyListFilterOpts<E extends FilterableElement> {
  /** Rendered elements to filter (NodeList, array, or any ArrayLike). */
  elements: ArrayLike<E>;
  /** Extract the filter attributes from one element. */
  getAttrs: (el: E) => ListFilterAttrs;
  /** The shared filter-bar predicate (`filterBar.matches`). */
  matches: (item: { folder: string; source: string; id?: string }) => boolean;
  /** Raw search query — lowercased + trimmed internally. */
  query: string;
  /** `style.display` value for visible elements ('' for monitoring, 'block' for yaml-scripts). */
  display?: string;
}

/**
 * Apply the filter to every element, toggling `style.display`.
 * @returns the number of visible elements.
 */
export function applyListFilter<E extends FilterableElement>(opts: ApplyListFilterOpts<E>): number {
  const { getAttrs, matches, display = '' } = opts;
  const query = opts.query.toLowerCase().trim();
  let visibleCount = 0;

  for (const el of Array.from(opts.elements)) {
    const { folder, source, id, searchText } = getAttrs(el);
    const textMatch = !query || searchText.toLowerCase().includes(query);
    const show = matches({ folder, source, id }) && textMatch;
    el.style.display = show ? display : 'none';
    if (show) visibleCount++;
  }

  return visibleCount;
}

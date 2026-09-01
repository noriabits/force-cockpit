/**
 * The field browser's row model: what the panel should show, computed purely
 * from state plus whatever describes are already resolved.
 *
 * This exists to separate "which describes does this state need" from
 * "render". The imperative version interleaved them — the row builder was
 * `async` and `await`ed `describeCache.getSObject(...)` in the middle of a
 * recursive walk, so a render pass could outlive the state that started it and
 * had to be policed by a hand-incremented `renderSeq` counter compared after
 * every await.
 *
 * Here the walk is synchronous over already-resolved data and reports what it
 * still needs. A caller fetches the `pending` names, stores them, and asks
 * again. A reply for an object the current state no longer names is written to
 * the cache and simply never read, so the race is gone structurally rather than
 * guarded.
 *
 * DOM-free (like `select-clause.ts` beside it) so it type-checks under the host
 * tsconfig and can be unit-tested directly.
 */

import { filterAndRankByMatch } from '../autocomplete/match-rank';

/** SOQL supports up to 5 levels of parent-relationship traversal. */
export const MAX_EXPAND_DEPTH = 5;

/** The describe projection this panel consumes. */
export interface DescribeField {
  name: string;
  label: string;
  type: string;
  relationshipName: string | null;
  referenceTo: string[];
  picklistValues: string[];
}

export interface DescribeObject {
  fields: DescribeField[];
}

/**
 * A resolved describe, `null` for one that came back empty or failed, and
 * `undefined` for one that has not been asked for yet.
 *
 * The null/undefined split is load-bearing: `pendingDescribes` must not
 * re-request an object the host has already answered with nothing, or an
 * expanded lookup onto an undescribable object would fetch forever.
 */
export type DescribeLookup = (name: string) => DescribeObject | null | undefined;

/** Which expansion set a chevron toggles, and under what key. */
export interface RowExpansion {
  set: 'ref' | 'picklist';
  key: string;
  expanded: boolean;
}

export type Row =
  | {
      kind: 'field';
      field: DescribeField;
      depth: number;
      /** The path a checkbox writes into the SELECT clause: `Owner.Name`. */
      checkboxPath: string;
      checked: boolean;
      /** `null` when no chevron should render for this row. */
      expansion: RowExpansion | null;
    }
  | { kind: 'picklistValues'; field: DescribeField; depth: number };

export interface RowModelInput {
  /** The object being browsed, once its describe has resolved. */
  object: DescribeObject;
  describeOf: DescribeLookup;
  /** Lowercased dotted relationship paths currently expanded. */
  expandedRefs: ReadonlySet<string>;
  /** Lowercased dotted field paths whose picklist values are shown. */
  expandedPicklists: ReadonlySet<string>;
  /** Lowercased simple field paths already in the SELECT clause. */
  selected: ReadonlySet<string>;
  /** False while browsing an object the query does not select from. */
  showCheckbox: boolean;
  /** Non-empty collapses the tree to a flat, unexpanded, ranked list. */
  search: string;
}

export interface RowModel {
  rows: Row[];
  /** Objects an expanded relationship needs, not yet resolved. */
  pending: string[];
}

/**
 * The three identities a field can be addressed by, relative to `pathPrefix`
 * (the dotted chain of relationshipNames leading to this object).
 */
export function fieldKeys(field: DescribeField, pathPrefix: string) {
  const checkboxPath = pathPrefix ? `${pathPrefix}.${field.name}` : field.name;
  const refKey = field.relationshipName
    ? (pathPrefix
        ? `${pathPrefix}.${field.relationshipName}`
        : field.relationshipName
      ).toLowerCase()
    : null;
  const picklistKey = field.type === 'picklist' ? checkboxPath.toLowerCase() : null;
  return { checkboxPath, refKey, picklistKey };
}

/**
 * Rows for the current state, plus the describes still needed to finish them.
 *
 * Returning both from ONE walk rather than exposing two functions is
 * deliberate: they would otherwise traverse the same tree under the same rules
 * twice per render, and could disagree after an edit to only one of them.
 */
export function buildRowModel(input: RowModelInput): RowModel {
  if (input.search) return { rows: flatSearchRows(input), pending: [] };

  const pending: string[] = [];
  const rows = treeRows(input, input.object, '', 0, pending);
  return { rows, pending };
}

/**
 * Search collapses the tree to a flat, ranked list of the browsed object's own
 * fields — filtering across a partially-expanded nested tree would be confusing
 * to read, so expansion state is set aside (not cleared) while searching.
 *
 * No row here carries an expansion: this branch emits no values row and no
 * nested fields, so a chevron would toggle state, re-render, and visibly do
 * nothing.
 */
function flatSearchRows(input: RowModelInput): Row[] {
  const matched = filterAndRankByMatch(input.object.fields, input.search, (f) => f.name);
  return matched.map((field) => ({
    kind: 'field' as const,
    field,
    depth: 0,
    checkboxPath: field.name,
    checked: input.showCheckbox && input.selected.has(field.name.toLowerCase()),
    expansion: null,
  }));
}

function treeRows(
  input: RowModelInput,
  object: DescribeObject,
  pathPrefix: string,
  depth: number,
  pending: string[],
): Row[] {
  const rows: Row[] = [];

  for (const field of object.fields) {
    const { checkboxPath, refKey, picklistKey } = fieldKeys(field, pathPrefix);
    const target = field.referenceTo[0];
    // The two chevrons are gated separately. `depth` carries SOQL's
    // parent-traversal limit, which a picklist is not subject to: its values
    // ride the describe already on screen and a chip inserts a literal at the
    // caret, so neither walks a relationship.
    const canExpandRef = !!refKey && !!target && depth < MAX_EXPAND_DEPTH;
    const refExpanded = canExpandRef && input.expandedRefs.has(refKey as string);
    const picklistExpanded = !!picklistKey && input.expandedPicklists.has(picklistKey);

    rows.push({
      kind: 'field',
      field,
      depth,
      checkboxPath,
      checked: input.showCheckbox && input.selected.has(checkboxPath.toLowerCase()),
      expansion: expansionFor(canExpandRef, refKey, refExpanded, picklistKey, picklistExpanded),
    });

    if (refExpanded) {
      const child = input.describeOf(target);
      if (child === undefined) pending.push(target);
      else if (child) {
        const childPrefix = pathPrefix
          ? `${pathPrefix}.${field.relationshipName}`
          : (field.relationshipName as string);
        rows.push(...treeRows(input, child, childPrefix, depth + 1, pending));
      }
    }

    if (picklistExpanded) rows.push({ kind: 'picklistValues', field, depth });
  }

  return rows;
}

function expansionFor(
  canExpandRef: boolean,
  refKey: string | null,
  refExpanded: boolean,
  picklistKey: string | null,
  picklistExpanded: boolean,
): RowExpansion | null {
  // A field is a reference or a picklist, never both, so the order here only
  // decides which of two impossible cases wins.
  if (canExpandRef) return { set: 'ref', key: refKey as string, expanded: refExpanded };
  if (picklistKey) return { set: 'picklist', key: picklistKey, expanded: picklistExpanded };
  return null;
}

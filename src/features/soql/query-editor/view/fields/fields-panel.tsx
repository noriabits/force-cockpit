// Field browser panel for the SOQL tab: a persistent, resizable column beside
// the editor (not a hide-on-blur dropdown like History, not below-the-fold like
// the AI panel) that lists an object's fields with a tick-to-select checkbox, so
// "what fields does this even have" doesn't require already knowing what to type
// into autocomplete. Reuses the same describeCache the autocomplete module uses
// (already coalesced/cached, already cleared on org change) — this panel adds no
// new host round-trips.
//
// ── WHAT GOES WHERE ──────────────────────────────────────────────────────────
// `field-rows.ts` owns what the list should CONTAIN, purely, from state plus
// whatever describes are already resolved. This file owns the DOM, the events,
// and fetching whatever that model says it still needs.
//
// That split is what let the render become synchronous. It used to be `async`
// all the way down and `await` a describe in the middle of a recursive walk, so
// a pass could outlive the state that started it and had to be policed by a
// hand-incremented `renderSeq` compared after every await. A late reply now
// writes into the describe map and is simply never read by the next render.
//
// ── THE MOUNT SEAM ───────────────────────────────────────────────────────────
// `listEl` is the mount CONTAINER — Preact owns its children, exactly as
// `history-dropdown.tsx` owns `dropdownEl`'s. Everything else the ctx names
// (`toggleBtn`, `closeBtn`, `objectBtn`, `searchInput`, `statusEl`, `panelEl`)
// stays PRE-EXISTING DOM from `view.html`, written from `effect()`s below and
// read by imperative listeners. That is deliberate: those five nodes are
// resolved by `getElementById` in `view/index.js` and handed in, so rendering
// them would detach the very elements the caller still holds. Keeping them
// outside is what let this port leave `index.js`, `view.html` and `view.css`
// completely untouched.
//
// ── STATE LIVES IN THE FACTORY CLOSURE ───────────────────────────────────────
// Never module scope, and never `useSignal`: `syncFromQuery` and `onOrgChanged`
// are called by `index.js` from outside any render, so hook-scoped state would
// be unreachable there. Reading a signal outside a render creates no
// subscription, so a plain `signal()` works from both sides.
//
// Every Set/Map signal is REPLACED, never mutated — a signal compares by
// reference, so `set.add(x)` would update nothing.

import { render } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { batch, computed, effect, signal } from '@preact/signals';
import { queryObjectName } from '../tab-name';
import { filterAndRankByMatch } from '../autocomplete/match-rank';
import { addFieldEdit, removeFieldEdit, selectedFieldSet } from './select-clause';
import { buildRowModel, type DescribeField, type DescribeObject, type Row } from './field-rows';

const win = window as unknown as {
  __setTooltip: (el: Element, text: string) => void;
};

/** A render pass over the full object list is capped — some orgs have thousands. */
const MAX_OBJECT_ROWS = 200;
/** One nesting level's indent, in px. */
const INDENT_PX = 14;

interface SObjectSummary {
  name: string;
  label: string;
}
interface GlobalDescribe {
  sobjects: SObjectSummary[];
}

/** An `{ start, end, text }` edit, or null for "nothing to do". */
type Edit = ReturnType<typeof addFieldEdit>;

export interface FieldsPanelCtx {
  panelEl: HTMLElement;
  /** The toolbar 🗂 Fields button. */
  toggleBtn: HTMLButtonElement;
  /** The panel header's own ✕. */
  closeBtn: HTMLButtonElement;
  /** Header button; also the object-picker toggle. */
  objectBtn: HTMLButtonElement;
  searchInput: HTMLInputElement;
  /** Mount container — see THE MOUNT SEAM above. */
  listEl: HTMLElement;
  statusEl: HTMLElement;
  textarea: HTMLTextAreaElement;
  describeCache: {
    getGlobal: () => Promise<GlobalDescribe | null>;
    getSObject: (name: string) => Promise<DescribeObject | null>;
  };
  isConnected: () => boolean;
  /**
   * Applies a text edit to the shared textarea and keeps the highlighter/tab
   * name/persistence in sync — the same contract the autocomplete module's
   * `onInsert` follows. A null edit is a no-op.
   */
  applyEdit: (edit: Edit) => void;
}

export function createFieldsPanel(ctx: FieldsPanelCtx) {
  const { panelEl, toggleBtn, closeBtn, objectBtn, searchInput, listEl, statusEl, textarea } = ctx;
  const { describeCache, isConnected, applyEdit } = ctx;

  const open = signal(false);
  const mode = signal<'fields' | 'objects'>('fields');
  /** Object currently shown in the list. */
  const browseObject = signal<string | null>(null);
  /** The active tab's own FROM object, tracked for the foreign-object guard. */
  const queryObject = signal<string | null>(null);
  /**
   * A mirror of the textarea, refreshed by `syncFromQuery` — which `index.js`
   * already calls after every edit, tab switch and applied edit. It is what
   * makes the checkboxes track the SELECT clause reactively.
   */
  const queryText = signal('');
  const searchQuery = signal('');
  /** Lowercased dotted relationship paths currently expanded. */
  const expandedRefs = signal<ReadonlySet<string>>(new Set());
  /** Lowercased dotted field paths whose picklist values are shown. */
  const expandedPicklists = signal<ReadonlySet<string>>(new Set());
  /**
   * `isConnected` is a plain ctx getter, so it is sampled at exactly the points
   * the imperative version would have called `render()`: open, syncFromQuery,
   * onOrgChanged. Same staleness characteristics, now reactive.
   */
  const connected = signal(false);

  // ── Resolved describes ────────────────────────────────────────────────────
  // Keyed lowercased. A `null` value means "described, came back with nothing"
  // and is deliberately distinct from an absent key: `buildRowModel` must not
  // re-request an object the host already answered with nothing, or an expanded
  // lookup onto an undescribable object would fetch forever.
  const describes = signal<ReadonlyMap<string, DescribeObject | null>>(new Map());
  /** Names already asked for, so a re-render mid-flight does not ask again. */
  const requested = new Set<string>();
  const globalDescribe = signal<GlobalDescribe | null>(null);
  let globalRequested = false;

  const describeOf = (name: string) => describes.value.get(name.toLowerCase());

  function storeDescribe(key: string, obj: DescribeObject | null) {
    const next = new Map(describes.value);
    next.set(key, obj);
    describes.value = next;
  }

  /**
   * Fetch each name we do not have yet. Every reply is stored (null included),
   * so a name can never come back round as pending — which is what makes this
   * terminate. A reply for an object the state no longer names is written and
   * simply never read: that is the whole stale-reply story, with no counter to
   * compare.
   */
  function fetchDescribes(names: readonly string[]) {
    for (const name of names) {
      const key = name.toLowerCase();
      if (requested.has(key)) continue;
      requested.add(key);
      void describeCache.getSObject(name).then((obj) => storeDescribe(key, obj ?? null));
    }
  }

  function fetchGlobal() {
    if (globalRequested) return;
    globalRequested = true;
    void describeCache.getGlobal().then((data) => {
      // A failed describeGlobal releases the guard so a later open retries.
      if (!data) globalRequested = false;
      globalDescribe.value = data;
    });
  }

  // ── Derived state ─────────────────────────────────────────────────────────
  const isForeignBrowse = computed(() => {
    const q = queryObject.value;
    const b = browseObject.value;
    return q !== null && b !== null && b.toLowerCase() !== q.toLowerCase();
  });

  /** The browsed object's describe: `undefined` unresolved, `null` empty. */
  const browsed = computed(() => {
    const name = browseObject.value;
    return name ? describeOf(name) : null;
  });

  const rowModel = computed(() => {
    const obj = browsed.value;
    if (!obj) return { rows: [] as Row[], pending: [] as string[] };
    return buildRowModel({
      object: obj,
      describeOf,
      expandedRefs: expandedRefs.value,
      expandedPicklists: expandedPicklists.value,
      selected: selectedFieldSet(queryText.value),
      showCheckbox: !isForeignBrowse.value,
      search: searchQuery.value,
    });
  });

  const matchedObjects = computed(() => {
    const global = globalDescribe.value;
    if (!global) return null;
    return filterAndRankByMatch(global.sobjects, searchQuery.value, (s) => s.name);
  });

  const statusText = computed(() => {
    if (!connected.value) return 'Connect to an org to browse fields.';

    if (mode.value === 'objects') {
      const matched = matchedObjects.value;
      if (!matched) return 'Loading objects…';
      return matched.length > MAX_OBJECT_ROWS
        ? `${MAX_OBJECT_ROWS} of ${matched.length} objects — keep typing to narrow`
        : `${matched.length} object${matched.length === 1 ? '' : 's'}`;
    }

    const name = browseObject.value;
    if (!name) return 'Type FROM <Object>, or pick an object above.';
    const obj = browsed.value;
    if (obj === undefined) return 'Loading…';
    if (obj === null) return `Could not describe ${name}.`;

    const total = `${obj.fields.length} field${obj.fields.length === 1 ? '' : 's'}`;
    // `X of Y` while filtered — the counter shape the results table, the
    // monitoring table filter and the object picker above all use.
    return searchQuery.value
      ? `${rowModel.value.rows.length} of ${total} on ${name}`
      : `${total} on ${name}`;
  });

  // ── Effects over the DOM this component does NOT own ──────────────────────
  effect(() => {
    panelEl.style.display = open.value ? '' : 'none';
    toggleBtn.classList.toggle('query-fields-toggle--open', open.value);
  });

  effect(() => {
    objectBtn.textContent = browseObject.value ? `${browseObject.value} ▾` : 'Choose object ▾';
  });

  effect(() => {
    if (open.value) statusEl.textContent = statusText.value;
  });

  /**
   * Fetching is an effect, never part of the model: a `computed` must stay
   * side-effect free, and this is the seam that replaced awaiting inside the
   * render walk. Gated on `open` so a closed panel costs nothing — the same
   * early return the imperative `render()` opened with.
   */
  effect(() => {
    if (!open.value || !connected.value) return;
    if (mode.value === 'objects') {
      if (!globalDescribe.value) fetchGlobal();
      return;
    }
    const name = browseObject.value;
    if (!name) return;
    if (browsed.value === undefined) fetchDescribes([name]);
    else if (rowModel.value.pending.length) fetchDescribes(rowModel.value.pending);
  });

  // ── Imperative listeners on the pre-existing controls ─────────────────────
  toggleBtn.addEventListener('click', () => {
    if (open.value) {
      open.value = false;
      return;
    }
    connected.value = isConnected();
    open.value = true;
    searchInput.focus();
  });

  closeBtn.addEventListener('click', () => {
    open.value = false;
  });

  objectBtn.addEventListener('click', () => {
    mode.value = mode.value === 'objects' ? 'fields' : 'objects';
    searchInput.value = '';
    searchQuery.value = '';
  });

  searchInput.addEventListener('input', () => {
    searchQuery.value = searchInput.value.trim();
  });

  function resetExpansions() {
    expandedRefs.value = new Set();
    expandedPicklists.value = new Set();
  }

  function toggleExpansion(set: 'ref' | 'picklist', key: string) {
    const target = set === 'ref' ? expandedRefs : expandedPicklists;
    const next = new Set(target.value);
    if (!next.delete(key)) next.add(key);
    target.value = next;
  }

  function pickObject(name: string) {
    browseObject.value = name;
    resetExpansions();
    mode.value = 'fields';
    searchInput.value = '';
    searchQuery.value = '';
  }

  function backToQueryObject() {
    browseObject.value = queryObject.value;
    resetExpansions();
  }

  /** Inserts `'Value'` at the textarea's current caret — for writing a WHERE literal. */
  function insertPicklistValue(value: string) {
    const quoted = `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    applyEdit({ start: textarea.selectionStart, end: textarea.selectionEnd, text: quoted });
    textarea.focus();
  }

  function onFieldToggled(checkboxPath: string, checked: boolean) {
    applyEdit(
      checked
        ? addFieldEdit(textarea.value, checkboxPath)
        : removeFieldEdit(textarea.value, checkboxPath),
    );
  }

  // ── Components ────────────────────────────────────────────────────────────
  /**
   * `__setTooltip` (media/modules/tooltip.js) is the one tooltip helper every
   * feature calls — VS Code webviews do not render native `title` reliably, and
   * it sets `data-tooltip` + `aria-label` together. Writing those attributes
   * from JSX instead would fork that rule, so the row keeps a ref and calls it.
   */
  function FieldRow({ row }: { row: Row & { kind: 'field' } }) {
    const ref = useRef<HTMLDivElement>(null);
    const tooltip = `${row.field.label} · ${row.field.type}`;
    useLayoutEffect(() => {
      if (ref.current) win.__setTooltip(ref.current, tooltip);
    }, [tooltip]);

    return (
      <div class="query-fields-row" ref={ref} style={{ paddingLeft: row.depth * INDENT_PX }}>
        <span class="query-fields-expand-slot">
          {row.expansion && (
            <button
              type="button"
              class="query-fields-expand"
              aria-label={row.expansion.expanded ? 'Collapse' : 'Expand'}
              onClick={() =>
                toggleExpansion(
                  (row.expansion as NonNullable<typeof row.expansion>).set,
                  (row.expansion as NonNullable<typeof row.expansion>).key,
                )
              }
            >
              {row.expansion.expanded ? '⌄' : '›'}
            </button>
          )}
        </span>
        {!isForeignBrowse.value && (
          <input
            type="checkbox"
            class="query-fields-checkbox"
            checked={row.checked}
            onChange={(e) => onFieldToggled(row.checkboxPath, e.currentTarget.checked)}
          />
        )}
        <span class="query-fields-name">{row.field.name}</span>
        <span class="query-fields-type">{row.field.type}</span>
      </div>
    );
  }

  function PicklistValues({ field, depth }: { field: DescribeField; depth: number }) {
    return (
      <div class="query-fields-picklist-values" style={{ paddingLeft: (depth + 1) * INDENT_PX }}>
        {field.picklistValues.length === 0 ? (
          <span class="query-fields-picklist-empty">No active values</span>
        ) : (
          field.picklistValues.map((value) => (
            <span
              key={value}
              class="query-fields-picklist-value"
              onClick={() => insertPicklistValue(value)}
            >
              {value}
            </span>
          ))
        )}
      </div>
    );
  }

  function ForeignBanner() {
    return (
      <div class="query-fields-banner">
        <span>Browsing {browseObject.value} — not the object this query selects from.</span>
        <button type="button" class="btn btn-ghost query-fields-back" onClick={backToQueryObject}>
          ↩ back to {queryObject.value}
        </button>
      </div>
    );
  }

  function ObjectPicker() {
    const matched = matchedObjects.value;
    if (!matched) return null;
    // Capped — some orgs return thousands of sobjects (managed packages), and
    // an unfiltered render of all of them would build a very slow DOM tree.
    return (
      <>
        {matched.slice(0, MAX_OBJECT_ROWS).map((sobject) => (
          <div
            key={sobject.name}
            class="query-fields-row query-fields-row--object"
            onClick={() => pickObject(sobject.name)}
          >
            <span class="query-fields-name">{sobject.name}</span>
            <span class="query-fields-type">{sobject.label}</span>
          </div>
        ))}
      </>
    );
  }

  function FieldBrowser() {
    if (!browsed.value) return null;
    return (
      <>
        {isForeignBrowse.value && <ForeignBanner />}
        {rowModel.value.rows.map((row, i) =>
          row.kind === 'picklistValues' ? (
            <PicklistValues key={`v:${row.field.name}:${i}`} field={row.field} depth={row.depth} />
          ) : (
            <FieldRow key={`f:${row.checkboxPath}:${i}`} row={row} />
          ),
        )}
      </>
    );
  }

  function Panel() {
    if (!open.value || !connected.value) return null;
    return mode.value === 'objects' ? <ObjectPicker /> : <FieldBrowser />;
  }

  render(<Panel />, listEl);

  // ── Public API — unchanged across the port, so index.js was not touched ────
  /**
   * Re-reads the active tab's FROM object. When it changed, the panel snaps
   * back to it (auto-follow) — the same reasoning as the AI panel's "what is on
   * screen" context: the browser should track what the user is actually
   * querying, not a stale pick from a previous tab or an earlier edit.
   *
   * The snap deliberately does NOT check `mode`. It used to only fire in
   * 'fields' mode, on the reasoning that an open object picker means a
   * deliberate browse that auto-follow must not override — but at that moment
   * nothing has been picked yet, so there is no browse to protect, and the list
   * on screen is objects rather than this object's fields. All the guard
   * achieved was suppressing auto-follow in the one window where it costs
   * something: editing the FROM clause with the picker open left `browseObject`
   * on the old object, so closing the picker landed on the foreign-browse banner
   * with every checkbox gone, and the user had to click "↩ back to X" to undo a
   * divergence they never asked for. A real pick still wins — it comes through
   * `pickObject`, after this.
   */
  function syncFromQuery() {
    const next = queryObjectName(textarea.value);
    const changed = (next ?? '').toLowerCase() !== (queryObject.value ?? '').toLowerCase();
    // Batched so the fetch effect sees the whole new state at once. Signal
    // writes run effects synchronously, so an unbatched sequence lets an effect
    // observe a half-applied state — see the note on onOrgChanged below.
    batch(() => {
      queryText.value = textarea.value;
      connected.value = isConnected();
      queryObject.value = next;
      if (changed) {
        browseObject.value = next;
        resetExpansions();
      }
    });
  }

  /**
   * Drop picker-only state (a manual foreign browse, an expanded tree, a
   * search) and re-derive the browsed object from the query text — never null it
   * out. The object named in a query's FROM clause isn't org-specific, so
   * there's nothing stale to discard there; the org-specific part (schema) is
   * dropped here and in `describeCache` itself.
   *
   * Nulling here instead of re-deriving was the actual bug behind a fields panel
   * that "loses" the object on a fresh window load: `orgConnected` and
   * `queryStateLoaded` race, and `orgConnected` often arrives *after* the tabs
   * have already loaded and `syncFromQuery` has set the object correctly —
   * wiping it right back out until the user switched tabs or typed something.
   */
  function onOrgChanged() {
    // The plain, non-signal request bookkeeping is cleared FIRST and the signal
    // writes are BATCHED, because signal writes run effects synchronously: an
    // unbatched `describes.value = new Map()` re-ran the fetch effect right
    // there, while `requested` still held every name from the previous org — so
    // every describe was skipped as already-asked-for and the panel came back
    // empty. Two ways to get this wrong, both fixed here; the characterization
    // suite is what caught it.
    requested.clear();
    globalRequested = false;
    const name = queryObjectName(textarea.value);
    batch(() => {
      mode.value = 'fields';
      resetExpansions();
      searchInput.value = '';
      searchQuery.value = '';
      describes.value = new Map();
      globalDescribe.value = null;
      queryText.value = textarea.value;
      connected.value = isConnected();
      queryObject.value = name;
      browseObject.value = name;
    });
  }

  return {
    syncFromQuery,
    close: () => {
      open.value = false;
    },
    onOrgChanged,
  };
}

// @ts-check
// Field browser panel for the SOQL tab: a persistent, resizable column beside
// the editor (not a hide-on-blur dropdown like History, not below-the-fold
// like the AI panel) that lists an object's fields with a tick-to-select
// checkbox, so "what fields does this even have" doesn't require already
// knowing what to type into autocomplete. Reuses the same describeCache the
// autocomplete module uses (already coalesced/cached, already cleared on org
// change) — this panel adds no new host round-trips.
//
// WHAT GOES WHERE: `field-rows.ts` owns what the list should contain, purely,
// from state plus already-resolved describes. This file owns the DOM, the
// events, and fetching whatever that model says it still needs. The render
// pass is therefore synchronous: it used to be `async` all the way down and
// `await` a describe in the middle of a recursive walk, which needed a
// hand-incremented `renderSeq` compared after every await to spot a pass that
// had outlived its own state.
import { queryObjectName } from '../tab-name';
import { filterAndRankByMatch } from '../autocomplete/match-rank';
import { addFieldEdit, removeFieldEdit, selectedFieldSet } from './select-clause';
import { buildRowModel } from './field-rows';

const win = /** @type {any} */ (window);

/** A render pass over the full object list is capped — some orgs have thousands. */
const MAX_OBJECT_ROWS = 200;
/** One nesting level's indent, in px. */
const INDENT_PX = 14;

/**
 * @typedef {import('./field-rows').DescribeField} DescribeField
 * @typedef {import('./field-rows').DescribeObject} DescribeObject
 * @typedef {import('./field-rows').Row} Row
 */

/**
 * @typedef {Object} FieldsPanelCtx
 * @property {HTMLElement} panelEl
 * @property {HTMLButtonElement} toggleBtn      The toolbar 🗂 Fields button.
 * @property {HTMLButtonElement} closeBtn       The panel header's own ✕.
 * @property {HTMLButtonElement} objectBtn      Header button; also the object-picker toggle.
 * @property {HTMLInputElement} searchInput
 * @property {HTMLElement} listEl
 * @property {HTMLElement} statusEl
 * @property {HTMLTextAreaElement} textarea
 * @property {{ getGlobal: () => Promise<any>, getSObject: (name: string) => Promise<any> }} describeCache
 * @property {() => boolean} isConnected
 * @property {(edit: { start: number, end: number, text: string } | null) => void} applyEdit
 *   Applies a text edit to the shared textarea and keeps the highlighter/tab
 *   name/persistence in sync — the same contract the autocomplete module's
 *   `onInsert` follows. A null edit is a no-op.
 */

/** @param {FieldsPanelCtx} ctx */
export function createFieldsPanel(ctx) {
  const { panelEl, toggleBtn, closeBtn, objectBtn, searchInput, listEl, statusEl, textarea } = ctx;
  const { describeCache, isConnected, applyEdit } = ctx;

  /** @type {'fields' | 'objects'} */
  let mode = 'fields';
  /** @type {string | null} object currently shown in the list */
  let browseObject = null;
  /** @type {string | null} the active tab's own FROM object, tracked for the foreign-object guard */
  let queryObject = null;
  let searchQuery = '';
  /** @type {Set<string>} lowercased dotted relationship paths currently expanded */
  const expandedRefs = new Set();
  /** @type {Set<string>} lowercased dotted field paths whose picklist values are shown */
  const expandedPicklists = new Set();

  // ── Resolved describes ────────────────────────────────────────────────────
  // Keyed lowercased. A `null` value means "described, came back with nothing"
  // and is deliberately distinct from an absent key: `buildRowModel` must not
  // re-request an object the host has already answered with nothing, or an
  // expanded lookup onto an undescribable object would fetch forever.
  /** @type {Map<string, DescribeObject | null>} */
  const describes = new Map();
  /** Names already asked for, so a re-render mid-flight does not ask again. */
  const requested = new Set();
  /** @type {any} the describeGlobal projection, once resolved */
  let globalDescribe = null;
  let globalRequested = false;

  /** @param {string} name */
  const describeOf = (name) => describes.get(name.toLowerCase());

  /**
   * Fetch each name we do not have yet, then re-render. Every reply is stored
   * (null included), so a name can never come back round as pending — which is
   * what makes this terminate.
   *
   * A reply for an object the state no longer names is written to the map and
   * simply never read by the next render. That is the whole stale-reply story:
   * there is no counter to compare, because a late write cannot paint.
   * @param {string[]} names
   */
  function fetchDescribes(names) {
    for (const name of names) {
      const key = name.toLowerCase();
      if (requested.has(key)) continue;
      requested.add(key);
      describeCache.getSObject(name).then((obj) => {
        describes.set(key, obj ?? null);
        render();
      });
    }
  }

  // ── Visibility ────────────────────────────────────────────────────────────
  function isOpen() {
    return panelEl.style.display !== 'none';
  }

  function openPanel() {
    panelEl.style.display = '';
    toggleBtn.classList.add('query-fields-toggle--open');
    render();
    searchInput.focus();
  }

  function closePanel() {
    panelEl.style.display = 'none';
    toggleBtn.classList.remove('query-fields-toggle--open');
  }

  toggleBtn.addEventListener('click', () => (isOpen() ? closePanel() : openPanel()));
  closeBtn.addEventListener('click', closePanel);

  // ── Object resolution ────────────────────────────────────────────────────
  /**
   * Re-reads the active tab's FROM object. When it changed, the panel snaps
   * back to it (auto-follow) — the same reasoning as the AI panel's "what is
   * on screen" context: the browser should track what the user is actually
   * querying, not a stale pick from a previous tab or an earlier edit.
   *
   * The snap deliberately does NOT check `mode`. It used to only fire in
   * 'fields' mode, on the reasoning that an open object picker means a
   * deliberate browse that auto-follow must not override — but at that moment
   * nothing has been picked yet, so there is no browse to protect, and the list
   * on screen is objects rather than this object's fields. All the guard
   * achieved was suppressing auto-follow in the one window where it costs
   * something: editing the FROM clause with the picker open left `browseObject`
   * on the old object, so closing the picker landed on the foreign-browse
   * banner with every checkbox gone, and the user had to click "↩ back to X"
   * to undo a divergence they never asked for. A real pick still wins — it
   * comes through `pickObject`, after this.
   */
  function syncFromQuery() {
    const next = queryObjectName(textarea.value);
    const changed = (next ?? '').toLowerCase() !== (queryObject ?? '').toLowerCase();
    queryObject = next;
    if (changed) {
      browseObject = queryObject;
      resetExpansions();
    }
    if (isOpen()) render();
  }

  function resetExpansions() {
    expandedRefs.clear();
    expandedPicklists.clear();
  }

  /** True once the browsed object diverges from what the query actually selects from. */
  function isForeignBrowse() {
    return (
      queryObject !== null &&
      browseObject !== null &&
      browseObject.toLowerCase() !== queryObject.toLowerCase()
    );
  }

  // ── Mode switching ───────────────────────────────────────────────────────
  objectBtn.addEventListener('click', () => {
    mode = mode === 'objects' ? 'fields' : 'objects';
    searchInput.value = '';
    searchQuery = '';
    render();
  });

  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value.trim();
    render();
  });

  /** @param {string} name */
  function pickObject(name) {
    browseObject = name;
    resetExpansions();
    mode = 'fields';
    searchInput.value = '';
    searchQuery = '';
    render();
  }

  function backToQueryObject() {
    browseObject = queryObject;
    resetExpansions();
    render();
  }

  // ── Render dispatch ──────────────────────────────────────────────────────
  function render() {
    if (!isOpen()) return;
    objectBtn.textContent = browseObject ? `${browseObject} ▾` : 'Choose object ▾';

    if (!isConnected()) {
      setStatus('Connect to an org to browse fields.');
      clearList();
      return;
    }
    if (mode === 'objects') {
      renderObjectPicker();
      return;
    }
    renderFieldBrowser();
  }

  function setStatus(/** @type {string} */ text) {
    statusEl.textContent = text;
  }

  function clearList() {
    listEl.innerHTML = '';
  }

  // ── Object picker ────────────────────────────────────────────────────────
  function renderObjectPicker() {
    if (!globalDescribe) {
      setStatus('Loading objects…');
      clearList();
      if (!globalRequested) {
        globalRequested = true;
        describeCache.getGlobal().then((data) => {
          globalDescribe = data;
          // A failed describeGlobal releases the guard so a later open retries.
          if (!data) globalRequested = false;
          render();
        });
      }
      return;
    }

    const matched = filterAndRankByMatch(
      globalDescribe.sobjects,
      searchQuery,
      (/** @type {any} */ s) => s.name,
    );
    clearList();
    // Capped — some orgs return thousands of sobjects (managed packages), and
    // an unfiltered render of all of them would build a very slow DOM tree.
    for (const sobject of matched.slice(0, MAX_OBJECT_ROWS)) {
      listEl.appendChild(buildObjectRow(sobject));
    }
    setStatus(
      matched.length > MAX_OBJECT_ROWS
        ? `${MAX_OBJECT_ROWS} of ${matched.length} objects — keep typing to narrow`
        : `${matched.length} object${matched.length === 1 ? '' : 's'}`,
    );
  }

  /** @param {{ name: string, label: string }} sobject */
  function buildObjectRow(sobject) {
    const row = document.createElement('div');
    row.className = 'query-fields-row query-fields-row--object';
    row.addEventListener('click', () => pickObject(sobject.name));

    const name = document.createElement('span');
    name.className = 'query-fields-name';
    name.textContent = sobject.name;
    row.appendChild(name);

    const label = document.createElement('span');
    label.className = 'query-fields-type';
    label.textContent = sobject.label;
    row.appendChild(label);

    return row;
  }

  // ── Field browser ────────────────────────────────────────────────────────
  function renderFieldBrowser() {
    if (!browseObject) {
      setStatus('Type FROM <Object>, or pick an object above.');
      clearList();
      return;
    }

    const obj = describeOf(browseObject);
    if (obj === undefined) {
      setStatus('Loading…');
      clearList();
      fetchDescribes([browseObject]);
      return;
    }
    if (obj === null) {
      setStatus(`Could not describe ${browseObject}.`);
      clearList();
      return;
    }

    const showCheckbox = !isForeignBrowse();
    const { rows, pending } = buildRowModel({
      object: obj,
      describeOf,
      expandedRefs,
      expandedPicklists,
      selected: selectedFieldSet(textarea.value),
      showCheckbox,
      search: searchQuery,
    });

    clearList();
    if (isForeignBrowse()) listEl.appendChild(buildForeignBanner());
    for (const row of rows) listEl.appendChild(buildRow(row, showCheckbox));

    const total = `${obj.fields.length} field${obj.fields.length === 1 ? '' : 's'}`;
    // `X of Y` while filtered — the counter shape the results table, the
    // monitoring table filter and the object picker above all use.
    setStatus(
      searchQuery ? `${rows.length} of ${total} on ${browseObject}` : `${total} on ${browseObject}`,
    );

    if (pending.length) fetchDescribes(pending);
  }

  function buildForeignBanner() {
    const banner = document.createElement('div');
    banner.className = 'query-fields-banner';

    const text = document.createElement('span');
    text.textContent = `Browsing ${browseObject} — not the object this query selects from.`;
    banner.appendChild(text);

    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'btn btn-ghost query-fields-back';
    back.textContent = `↩ back to ${queryObject}`;
    back.addEventListener('click', backToQueryObject);
    banner.appendChild(back);

    return banner;
  }

  // ── Rows ─────────────────────────────────────────────────────────────────
  /** @param {Row} row @param {boolean} showCheckbox */
  function buildRow(row, showCheckbox) {
    return row.kind === 'picklistValues'
      ? buildPicklistValuesRow(row.field, row.depth)
      : buildFieldRow(row, showCheckbox);
  }

  /** @param {Row & { kind: 'field' }} row @param {boolean} showCheckbox */
  function buildFieldRow(row, showCheckbox) {
    const { field } = row;

    const el = document.createElement('div');
    el.className = 'query-fields-row';
    el.style.paddingLeft = row.depth * INDENT_PX + 'px';
    win.__setTooltip(el, `${field.label} · ${field.type}`);

    el.appendChild(buildExpandSlot(row));
    if (showCheckbox) el.appendChild(buildCheckbox(row));

    const name = document.createElement('span');
    name.className = 'query-fields-name';
    name.textContent = field.name;
    el.appendChild(name);

    const type = document.createElement('span');
    type.className = 'query-fields-type';
    type.textContent = field.type;
    el.appendChild(type);

    return el;
  }

  /** @param {Row & { kind: 'field' }} row */
  function buildExpandSlot(row) {
    const slot = document.createElement('span');
    slot.className = 'query-fields-expand-slot';
    if (!row.expansion) return slot;

    const { set, key, expanded } = row.expansion;
    const target = set === 'ref' ? expandedRefs : expandedPicklists;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'query-fields-expand';
    btn.textContent = expanded ? '⌄' : '›';
    btn.setAttribute('aria-label', expanded ? 'Collapse' : 'Expand');
    btn.addEventListener('click', () => {
      if (target.has(key)) target.delete(key);
      else target.add(key);
      render();
    });
    slot.appendChild(btn);
    return slot;
  }

  /** @param {Row & { kind: 'field' }} row */
  function buildCheckbox(row) {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'query-fields-checkbox';
    checkbox.checked = row.checked;
    checkbox.addEventListener('change', () => {
      const edit = checkbox.checked
        ? addFieldEdit(textarea.value, row.checkboxPath)
        : removeFieldEdit(textarea.value, row.checkboxPath);
      applyEdit(edit);
    });
    return checkbox;
  }

  /** @param {DescribeField} field @param {number} depth */
  function buildPicklistValuesRow(field, depth) {
    const wrap = document.createElement('div');
    wrap.className = 'query-fields-picklist-values';
    wrap.style.paddingLeft = (depth + 1) * INDENT_PX + 'px';

    if (field.picklistValues.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'query-fields-picklist-empty';
      empty.textContent = 'No active values';
      wrap.appendChild(empty);
      return wrap;
    }

    for (const value of field.picklistValues) {
      const chip = document.createElement('span');
      chip.className = 'query-fields-picklist-value';
      chip.textContent = value;
      chip.addEventListener('click', () => insertPicklistValue(value));
      wrap.appendChild(chip);
    }
    return wrap;
  }

  /** Inserts `'Value'` at the textarea's current caret — for writing a WHERE literal. */
  function insertPicklistValue(/** @type {string} */ value) {
    const quoted = `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    applyEdit({ start: textarea.selectionStart, end: textarea.selectionEnd, text: quoted });
    textarea.focus();
  }

  // ── Org change ───────────────────────────────────────────────────────────
  /**
   * Drop picker-only state (a manual foreign browse, an expanded tree, a
   * search) and re-derive the browsed object from the query text — never null
   * it out. The object named in a query's FROM clause isn't org-specific, so
   * there's nothing stale to discard there; the org-specific part (schema) is
   * dropped here and in `describeCache` itself.
   *
   * Nulling here instead of re-deriving was the actual bug behind a fields
   * panel that "loses" the object on a fresh window load: `orgConnected` and
   * `queryStateLoaded` race, and `orgConnected` often arrives *after* the tabs
   * have already loaded and `syncFromQuery` has set the object correctly —
   * wiping it right back out until the user switched tabs or typed something.
   */
  function onOrgChanged() {
    mode = 'fields';
    resetExpansions();
    searchInput.value = '';
    searchQuery = '';
    describes.clear();
    requested.clear();
    globalDescribe = null;
    globalRequested = false;
    queryObject = queryObjectName(textarea.value);
    browseObject = queryObject;
    if (isOpen()) render();
  }

  return { syncFromQuery, close: closePanel, onOrgChanged };
}

// @ts-check
// Field browser panel for the SOQL tab: a persistent, resizable column beside
// the editor (not a hide-on-blur dropdown like History, not below-the-fold
// like the AI panel) that lists an object's fields with a tick-to-select
// checkbox, so "what fields does this even have" doesn't require already
// knowing what to type into autocomplete. Reuses the same describeCache the
// autocomplete module uses (already coalesced/cached, already cleared on org
// change) — this panel adds no new host round-trips.
import { queryObjectName } from '../tab-name';
import { filterAndRankByMatch } from '../autocomplete/match-rank';
import { addFieldEdit, removeFieldEdit, selectedFieldSet } from './select-clause';

const win = /** @type {any} */ (window);

/** SOQL supports up to 5 levels of parent-relationship traversal. */
const MAX_EXPAND_DEPTH = 5;
/** A render pass over the full object list is capped — some orgs have thousands. */
const MAX_OBJECT_ROWS = 200;

/**
 * @typedef {Object} DescribeField
 * @property {string} name
 * @property {string} label
 * @property {string} type
 * @property {string | null} relationshipName
 * @property {string[]} referenceTo
 * @property {string[]} picklistValues
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
  /** Stale-async guard for the describe round-trips a render pass may need. */
  let renderSeq = 0;

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
  async function renderObjectPicker() {
    setStatus('Loading objects…');
    const seq = ++renderSeq;
    const global = await describeCache.getGlobal();
    if (seq !== renderSeq) return;
    if (!global) {
      setStatus('Could not load the list of objects.');
      clearList();
      return;
    }

    const matched = filterAndRankByMatch(
      global.sobjects,
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
  async function renderFieldBrowser() {
    if (!browseObject) {
      setStatus('Type FROM <Object>, or pick an object above.');
      clearList();
      return;
    }

    const seq = ++renderSeq;
    setStatus('Loading…');
    const obj = await describeCache.getSObject(browseObject);
    if (seq !== renderSeq) return;
    if (!obj) {
      setStatus(`Could not describe ${browseObject}.`);
      clearList();
      return;
    }

    clearList();
    if (isForeignBrowse()) listEl.appendChild(buildForeignBanner());

    const showCheckbox = !isForeignBrowse();
    const selected = selectedFieldSet(textarea.value);

    if (searchQuery) {
      // Search collapses to a flat, unexpanded list of the browsed object's
      // own fields — filtering across an already-expanded nested tree would
      // be confusing to read, so expansion state is simply set aside here.
      const matched = filterAndRankByMatch(obj.fields, searchQuery, (f) => f.name);
      for (const field of matched) {
        listEl.appendChild(buildFieldRow(field, '', 0, showCheckbox, selected, false, false));
      }
      // `X of Y`, the same counter shape the results table, the monitoring
      // table filter and the object picker below all use. This used to report
      // the object's total field count while the list showed a filtered
      // handful, so the number named nothing on screen.
      setStatus(`${matched.length} of ${fieldCount(obj)} on ${browseObject}`);
      return;
    }

    const rows = await buildTreeRows(obj, '', 0, showCheckbox, selected, seq);
    if (seq !== renderSeq) return;
    for (const row of rows) listEl.appendChild(row);
    setStatus(`${fieldCount(obj)} on ${browseObject}`);
  }

  /** @param {{ fields: unknown[] }} obj */
  function fieldCount(obj) {
    return `${obj.fields.length} field${obj.fields.length === 1 ? '' : 's'}`;
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

  // ── Field tree ───────────────────────────────────────────────────────────
  /**
   * The three identities a field can be addressed by, relative to `pathPrefix`
   * (the dotted chain of relationshipNames leading to this object).
   * @param {DescribeField} field @param {string} pathPrefix
   */
  function fieldKeys(field, pathPrefix) {
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
   * Recursively builds rows for `obj`'s fields, expanding any relationship or
   * picklist the user has toggled open. One describe round-trip per expanded
   * relationship (cached by describeCache, so re-renders after the first are free).
   * @param {any} obj @param {string} pathPrefix @param {number} depth
   * @param {boolean} showCheckbox @param {Set<string>} selected @param {number} seq
   * @returns {Promise<HTMLElement[]>}
   */
  async function buildTreeRows(obj, pathPrefix, depth, showCheckbox, selected, seq) {
    const rows = [];
    for (const field of obj.fields) {
      rows.push(
        buildFieldRow(
          field,
          pathPrefix,
          depth,
          showCheckbox,
          selected,
          depth < MAX_EXPAND_DEPTH,
          true,
        ),
      );

      const { refKey, picklistKey } = fieldKeys(field, pathPrefix);
      if (refKey && expandedRefs.has(refKey) && field.referenceTo[0] && depth < MAX_EXPAND_DEPTH) {
        const child = await describeCache.getSObject(field.referenceTo[0]);
        if (seq !== renderSeq) return rows;
        if (child) {
          const childPrefix = pathPrefix
            ? `${pathPrefix}.${field.relationshipName}`
            : field.relationshipName;
          rows.push(
            ...(await buildTreeRows(child, childPrefix, depth + 1, showCheckbox, selected, seq)),
          );
        }
      }
      if (picklistKey && expandedPicklists.has(picklistKey)) {
        rows.push(buildPicklistValuesRow(field, depth));
      }
    }
    return rows;
  }

  /**
   * @param {DescribeField} field @param {string} pathPrefix @param {number} depth
   * @param {boolean} showCheckbox @param {Set<string>} selected
   * @param {boolean} allowRefExpand @param {boolean} allowPicklistExpand
   */
  function buildFieldRow(
    field,
    pathPrefix,
    depth,
    showCheckbox,
    selected,
    allowRefExpand,
    allowPicklistExpand,
  ) {
    const { checkboxPath, refKey, picklistKey } = fieldKeys(field, pathPrefix);

    const row = document.createElement('div');
    row.className = 'query-fields-row';
    row.style.paddingLeft = depth * 14 + 'px';
    win.__setTooltip(row, `${field.label} · ${field.type}`);

    row.appendChild(
      buildExpandSlot(field, refKey, picklistKey, allowRefExpand, allowPicklistExpand),
    );
    if (showCheckbox) row.appendChild(buildCheckbox(field, checkboxPath, selected));

    const name = document.createElement('span');
    name.className = 'query-fields-name';
    name.textContent = field.name;
    row.appendChild(name);

    const type = document.createElement('span');
    type.className = 'query-fields-type';
    type.textContent = field.type;
    row.appendChild(type);

    return row;
  }

  /**
   * The two chevrons are gated SEPARATELY, and one flag for both was a bug in
   * each direction. `allowRefExpand` carries SOQL's 5-level parent-traversal
   * limit, which a picklist is not subject to — its values ride the describe
   * projection already on screen and a chip inserts a literal at the caret, so
   * neither walks a relationship — and sharing the flag hid the chevron on
   * every picklist at the deepest level. `allowPicklistExpand` is what search
   * mode turns off: that branch renders a flat list and never emits a values
   * row, so a chevron there would toggle state, re-render, and visibly do
   * nothing.
   * @param {DescribeField} field @param {string | null} refKey
   * @param {string | null} picklistKey
   * @param {boolean} allowRefExpand @param {boolean} allowPicklistExpand
   */
  function buildExpandSlot(field, refKey, picklistKey, allowRefExpand, allowPicklistExpand) {
    const slot = document.createElement('span');
    slot.className = 'query-fields-expand-slot';

    const canExpandRef = allowRefExpand && refKey && field.referenceTo[0];
    const canExpandPicklist = allowPicklistExpand && picklistKey;
    if (!canExpandRef && !canExpandPicklist) return slot;

    const expandedSet = canExpandRef ? expandedRefs : expandedPicklists;
    const key = /** @type {string} */ (canExpandRef ? refKey : picklistKey);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'query-fields-expand';
    const expanded = expandedSet.has(key);
    btn.textContent = expanded ? '⌄' : '›';
    btn.setAttribute('aria-label', expanded ? 'Collapse' : 'Expand');
    btn.addEventListener('click', () => {
      if (expandedSet.has(key)) expandedSet.delete(key);
      else expandedSet.add(key);
      render();
    });
    slot.appendChild(btn);
    return slot;
  }

  /** @param {DescribeField} field @param {string} checkboxPath @param {Set<string>} selected */
  function buildCheckbox(field, checkboxPath, selected) {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'query-fields-checkbox';
    checkbox.checked = selected.has(checkboxPath.toLowerCase());
    checkbox.addEventListener('change', () => {
      const edit = checkbox.checked
        ? addFieldEdit(textarea.value, checkboxPath)
        : removeFieldEdit(textarea.value, checkboxPath);
      applyEdit(edit);
    });
    return checkbox;
  }

  /** @param {DescribeField} field @param {number} depth */
  function buildPicklistValuesRow(field, depth) {
    const wrap = document.createElement('div');
    wrap.className = 'query-fields-picklist-values';
    wrap.style.paddingLeft = (depth + 1) * 14 + 'px';

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
   * `describeCache`'s own job and already gets cleared elsewhere on disconnect.
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
    queryObject = queryObjectName(textarea.value);
    browseObject = queryObject;
    if (isOpen()) render();
  }

  return { syncFromQuery, close: closePanel, onOrgChanged };
}

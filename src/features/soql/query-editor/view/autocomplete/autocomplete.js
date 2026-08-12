// @ts-check
// SOQL autocomplete dropdown for the SOQL tab. Computes the cursor
// context (soql-context.ts), fetches the needed describe metadata lazily via the
// describe cache, renders a suggestion list anchored below the caret line, and
// inserts the chosen value with textarea.setRangeText. Keyboard: ↑/↓ move,
// Enter/Tab insert, Esc dismiss; Ctrl+Space forces suggestions.
import { analyzeSoql } from './soql-context';
import { getCaretCoordinates } from './caret-position';

/**
 * @typedef {Object} AutocompleteCtx
 * @property {HTMLTextAreaElement} textarea
 * @property {HTMLElement} dropdownEl
 * @property {ReturnType<import('./describe-cache').createDescribeCache>} describeCache
 * @property {() => boolean} isConnected
 * @property {() => void} onInsert  Called after a value is inserted (sync tab state).
 */

/** @param {AutocompleteCtx} ctx */
export function createAutocomplete(ctx) {
  const { textarea, dropdownEl, describeCache, isConnected, onInsert } = ctx;

  /** @type {{ label: string, detail: string, insert: string, reopen: boolean }[]} */
  let items = [];
  let activeIndex = -1;
  let open = false;
  let seq = 0; // guards against stale async renders
  /** @type {{ replaceStart: number, replaceEnd: number } | null} */
  let pendingReplace = null;

  function hide() {
    open = false;
    activeIndex = -1;
    items = [];
    pendingReplace = null;
    dropdownEl.style.display = 'none';
    dropdownEl.innerHTML = '';
  }

  function render() {
    if (items.length === 0) {
      hide();
      return;
    }
    dropdownEl.innerHTML = '';
    items.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = 'query-ac-item' + (i === activeIndex ? ' query-ac-item--active' : '');
      const label = document.createElement('span');
      label.className = 'query-ac-label';
      label.textContent = item.label;
      row.appendChild(label);
      if (item.detail) {
        const detail = document.createElement('span');
        detail.className = 'query-ac-detail';
        detail.textContent = item.detail;
        row.appendChild(detail);
      }
      row.addEventListener('mousedown', (e) => {
        e.preventDefault(); // keep textarea focus
        choose(i);
      });
      dropdownEl.appendChild(row);
    });
    // Must flip visible before measuring: offsetParent reads null while the
    // element still has display:none, which would silently mis-anchor the
    // dropdown against document.body instead of its real positioned ancestor.
    dropdownEl.style.display = '';
    positionDropdown();
    open = true;
  }

  /**
   * Anchors the dropdown just below the caret's own (wrapped) line, not the
   * bottom of the whole textarea — otherwise editing a field in the middle of
   * an already-written multi-line query pops the list up far from the caret,
   * which reads as "no suggestions" even though the DOM node is there.
   */
  function positionDropdown() {
    const caretPos = pendingReplace ? pendingReplace.replaceEnd : textarea.selectionStart;
    const { top: caretTop, left: caretLeft, lineHeight } = getCaretCoordinates(textarea, caretPos);
    // getCaretCoordinates measures from the mirror's padding edge (offsetTop is
    // relative to the offsetParent's padding edge), while getBoundingClientRect
    // returns the textarea's outer border edge — add the border widths back in
    // so the two frames of reference line up.
    const textareaStyle = getComputedStyle(textarea);
    const borderTop = parseFloat(textareaStyle.borderTopWidth) || 0;
    const borderLeft = parseFloat(textareaStyle.borderLeftWidth) || 0;
    const posParent = /** @type {HTMLElement} */ (dropdownEl.offsetParent) || document.body;
    const parentRect = posParent.getBoundingClientRect();
    const textareaRect = textarea.getBoundingClientRect();
    const top =
      textareaRect.top -
      parentRect.top +
      borderTop +
      caretTop -
      textarea.scrollTop +
      lineHeight +
      2;
    const left = textareaRect.left - parentRect.left + borderLeft + caretLeft - textarea.scrollLeft;
    dropdownEl.style.top = top + 'px';
    dropdownEl.style.left = left + 'px';
  }

  /** @param {number} i */
  function choose(i) {
    const item = items[i];
    if (!item || !pendingReplace) return;
    textarea.focus();
    textarea.setRangeText(
      item.insert,
      pendingReplace.replaceStart,
      pendingReplace.replaceEnd,
      'end',
    );
    onInsert();
    hide();
    // A relationship insert ends in '.', so reopen to suggest the next segment.
    if (item.reopen) trigger(true);
  }

  // ── Suggestion building ───────────────────────────────────────────────────
  /** @param {string} token @param {string} candidate */
  function matches(token, candidate) {
    return candidate.toLowerCase().includes(token.toLowerCase());
  }

  // SOQL's FIELDS() shorthand — the only three variants Salesforce documents.
  // These are literal syntax, not real field names, so they never come back
  // from a describe call and would otherwise be invisible to autocomplete.
  // Only valid directly in the SELECT list (never WHERE/GROUP BY/ORDER BY/
  // HAVING) and never on a relationship path (no `Account.FIELDS(ALL)`).
  const FIELDS_SHORTHAND = [
    { insert: 'FIELDS(ALL)', detail: 'All fields (max 200 rows)' },
    { insert: 'FIELDS(STANDARD)', detail: 'Standard fields only' },
    { insert: 'FIELDS(CUSTOM)', detail: 'Custom fields only' },
  ];

  /**
   * @param {import('./soql-context').SoqlContext & { kind: 'field' }} ctxResult
   * @param {string} token
   */
  function fieldsShorthandSuggestions(ctxResult, token) {
    if (ctxResult.clause !== 'SELECT' || ctxResult.relationshipPath.length > 0) return [];
    // Gate on the bare word "FIELDS", not the full "FIELDS(ALL)" string: once
    // the user has typed the opening paren the identifier-token parser only
    // sees what's inside it (e.g. "AL"), and replacing that with the full
    // "FIELDS(ALL)" string would duplicate the "FIELDS(" already on screen.
    if (!matches(token, 'FIELDS')) return [];
    return FIELDS_SHORTHAND.map((f) => ({
      label: f.insert,
      detail: f.detail,
      insert: f.insert,
      reopen: false,
    }));
  }

  /**
   * Walk a relationship path from the FROM object to the object to complete against.
   * @param {string} fromObject
   * @param {string[]} relationshipPath
   */
  async function resolveObject(fromObject, relationshipPath) {
    let obj = await describeCache.getSObject(fromObject);
    for (const seg of relationshipPath) {
      if (!obj) return null;
      const f = obj.fields.find(
        (/** @type {any} */ fl) =>
          fl.relationshipName && fl.relationshipName.toLowerCase() === seg.toLowerCase(),
      );
      if (!f || !f.referenceTo[0]) return null;
      obj = await describeCache.getSObject(f.referenceTo[0]);
    }
    return obj;
  }

  /** @param {boolean} manual */
  async function trigger(manual) {
    if (!isConnected()) return hide();
    const mySeq = ++seq;
    const ctxResult = analyzeSoql(textarea.value, textarea.selectionStart);

    if (ctxResult.kind === 'none') return hide();
    // Avoid noise: only auto-open once a prefix is typed (Ctrl+Space overrides).
    if (!manual && ctxResult.token.length < 1) return hide();

    /** @type {{ label: string, detail: string, insert: string, reopen: boolean }[]} */
    let next = [];

    if (ctxResult.kind === 'object') {
      const g = await describeCache.getGlobal();
      if (mySeq !== seq || !g) return;
      next = g.sobjects
        .filter((/** @type {any} */ s) => matches(ctxResult.token, s.name))
        .slice(0, 50)
        .map((/** @type {any} */ s) => ({
          label: s.name,
          detail: s.label,
          insert: s.name,
          reopen: false,
        }));
    } else if (ctxResult.kind === 'field') {
      const obj = await resolveObject(ctxResult.fromObject, ctxResult.relationshipPath);
      if (mySeq !== seq || !obj) return;
      const token = ctxResult.token;
      const rels = obj.fields
        .filter((/** @type {any} */ f) => f.relationshipName && matches(token, f.relationshipName))
        .map((/** @type {any} */ f) => ({
          label: f.relationshipName + '.',
          detail: f.referenceTo[0] || 'reference',
          insert: f.relationshipName + '.',
          reopen: true,
        }));
      const fields = obj.fields
        .filter((/** @type {any} */ f) => matches(token, f.name))
        .map((/** @type {any} */ f) => ({
          label: f.name,
          detail: f.type,
          insert: f.name,
          reopen: false,
        }));
      const fieldsShorthand = fieldsShorthandSuggestions(ctxResult, token);
      next = [...fieldsShorthand, ...rels, ...fields].slice(0, 50);
    } else if (ctxResult.kind === 'picklist') {
      const obj = await describeCache.getSObject(ctxResult.fromObject);
      if (mySeq !== seq || !obj) return;
      const field = obj.fields.find(
        (/** @type {any} */ f) => f.name.toLowerCase() === ctxResult.pickField.toLowerCase(),
      );
      if (!field) return hide();
      next = field.picklistValues
        .filter((/** @type {string} */ v) => matches(ctxResult.token, v))
        .slice(0, 50)
        .map((/** @type {string} */ v) => ({
          label: v,
          detail: 'picklist',
          insert: v,
          reopen: false,
        }));
    }

    if (mySeq !== seq) return;
    items = next;
    activeIndex = items.length > 0 ? 0 : -1;
    pendingReplace = { replaceStart: ctxResult.replaceStart, replaceEnd: ctxResult.replaceEnd };
    render();
  }

  // ── Wiring ────────────────────────────────────────────────────────────────
  textarea.addEventListener('input', () => trigger(false));

  textarea.addEventListener(
    'keydown',
    (e) => {
      // Ctrl+Space forces suggestions even with no typed prefix.
      if (e.ctrlKey && e.code === 'Space') {
        e.preventDefault();
        trigger(true);
        return;
      }
      if (!open) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeIndex = (activeIndex + 1) % items.length;
        render();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeIndex = (activeIndex - 1 + items.length) % items.length;
        render();
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation(); // don't trigger Cmd+Enter run / tab-out
        choose(activeIndex);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        hide();
      }
    },
    true, // capture so we intercept before the run-shortcut handler
  );

  textarea.addEventListener('blur', () => setTimeout(hide, 120));

  return { hide };
}

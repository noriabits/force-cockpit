// @ts-check
// Custom hover tooltip for webview elements.
//
// VS Code webviews don't reliably render the native OS `title` tooltip, so this
// module shows a styled tooltip element appended to <body> — which escapes any
// ancestor `overflow: hidden` (e.g. the accordion cards). Opt in by giving an
// element a `data-tooltip` attribute (use the win.__setTooltip(el, text) helper
// below, which also sets `aria-label`); one delegated set of listeners here
// handles every such element on the page, however it was created — bundled
// feature view bundles, plain feature scripts, or static HTML in main.html.
// Styling lives in media/main.css (.fc-tooltip).

(function () {
  const win = /** @type {any} */ (window);

  /** @type {HTMLElement | null} */
  let tooltipEl = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let showTimer = null;
  /** @type {HTMLElement | null} */
  let currentTarget = null;
  const delayMs = 400;

  function ensureEl() {
    if (tooltipEl) return tooltipEl;
    const el = document.createElement('div');
    el.className = 'fc-tooltip';
    el.setAttribute('role', 'tooltip');
    document.body.appendChild(el);
    tooltipEl = el;
    return el;
  }

  /** @param {HTMLElement} target */
  function show(target) {
    const text = target.getAttribute('data-tooltip');
    if (!text) return;
    const el = ensureEl();
    el.textContent = text;
    el.style.display = 'block';
    // Measure after the text/display are set, then anchor to the target.
    const rect = target.getBoundingClientRect();
    const tip = el.getBoundingClientRect();
    let top = rect.top - tip.height - 6;
    if (top < 4) top = rect.bottom + 6; // flip below when there's no room above
    let left = rect.left + rect.width / 2 - tip.width / 2;
    left = Math.max(4, Math.min(left, window.innerWidth - tip.width - 4));
    el.style.top = `${Math.round(top)}px`;
    el.style.left = `${Math.round(left)}px`;
    el.classList.add('fc-tooltip--visible');
  }

  function hide() {
    currentTarget = null;
    if (showTimer) {
      clearTimeout(showTimer);
      showTimer = null;
    }
    if (tooltipEl) {
      tooltipEl.classList.remove('fc-tooltip--visible');
      tooltipEl.style.display = 'none';
    }
  }

  document.addEventListener('mouseover', (e) => {
    const t = /** @type {HTMLElement | null} */ (e.target);
    const target = /** @type {HTMLElement | null} */ (t?.closest('[data-tooltip]'));
    if (!target || target === currentTarget) return;
    currentTarget = target;
    if (showTimer) clearTimeout(showTimer);
    showTimer = setTimeout(() => show(target), delayMs);
  });
  document.addEventListener('mouseout', (e) => {
    if (!currentTarget) return;
    const related = /** @type {Node | null} */ (/** @type {MouseEvent} */ (e).relatedTarget);
    if (!related || !currentTarget.contains(related)) hide();
  });
  // A click (e.g. the accordion toggling, or a button firing) or any scroll
  // dismisses an open tooltip so it can't linger over re-rendered content.
  document.addEventListener('click', hide, true);
  window.addEventListener('scroll', hide, true);

  /**
   * Shared helper: opt an element into the custom tooltip + keep it accessible.
   * @param {HTMLElement} el
   * @param {string} text
   */
  win.__setTooltip = function (el, text) {
    el.setAttribute('data-tooltip', text);
    el.setAttribute('aria-label', text);
  };
})();

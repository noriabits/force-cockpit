// @ts-check
/**
 * Scroll a just-rendered element into view and briefly flash a highlight class.
 * Used after a save/update so the affected card/accordion is easy to spot.
 *
 * Runs inside `requestAnimationFrame` so the element exists after the caller's
 * synchronous re-render. No-op if the selector matches nothing.
 *
 * @param {ParentNode} container - element to query within (e.g. the list root).
 * @param {string} selector - CSS selector for the target (caller escapes ids).
 * @param {string} highlightClass - class toggled on for `durationMs`.
 * @param {number} [durationMs=1500]
 */
export function scrollAndHighlight(container, selector, highlightClass, durationMs = 1500) {
  requestAnimationFrame(() => {
    const el = /** @type {HTMLElement | null} */ (container.querySelector(selector));
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    el.classList.add(highlightClass);
    setTimeout(() => el.classList.remove(highlightClass), durationMs);
  });
}

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

/**
 * Returns true when `el` is scrolled to (or within `threshold` px of) its
 * bottom. Use to decide whether to keep an auto-following log pinned.
 * @param {HTMLElement} el
 * @param {number} [threshold]
 */
export function isScrolledToBottom(el, threshold = 24) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

/**
 * Pins `el` to its bottom unconditionally. Use when starting a new run in a
 * streaming pane: writing the next turn's header grows the content without
 * moving the scroll position, which leaves the pane no longer at the bottom —
 * so every subsequent `stickToBottom` check reads false and the output silently
 * stops following while the model is still writing.
 * @param {HTMLElement} el
 */
export function scrollToBottom(el) {
  el.scrollTop = el.scrollHeight;
}

/**
 * Pins `el` to its bottom only if it was already at the bottom before its
 * content changed. Capture `wasAtBottom` BEFORE mutating content, then call
 * this AFTER. Scrolling up mid-stream is what stops the pane following, so
 * re-anchor with `scrollToBottom` when a new run starts.
 * @param {HTMLElement} el
 * @param {boolean} wasAtBottom
 */
export function stickToBottom(el, wasAtBottom) {
  if (wasAtBottom) scrollToBottom(el);
}

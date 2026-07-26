// @ts-check
// Syntax-highlight overlay for the Quick Query textarea. The textarea keeps its
// own text transparent and sits on top of a <pre> that renders the same string
// tokenized into coloured spans, so caret, selection and native editing all stay
// exactly as they were.
//
// A highlight.js overlay was tried once for the yaml-scripts code editor and
// removed (commit d26c7d5) — everything that went wrong then is guarded here:
//   - a throw in the renderer used to leave the transparent textarea looking
//     EMPTY, so every render is wrapped and falls back to plain text
//   - a <pre> collapses its final newline, so one is appended before rendering
//   - highlighting on every keystroke is rAF-throttled
//   - the textarea is `resize: vertical`, so a ResizeObserver re-syncs
//   - scroll position is mirrored on every scroll event
// The metrics that must match pixel-for-pixel (font, line-height, padding,
// border, wrapping) live in one shared CSS rule in media/main.css.

import { tokenizeSoql } from './soql-tokens';

const win = /** @type {any} */ (window);

/** @type {Record<string, string>} */
const TOKEN_CLASS = {
  keyword: 'tok-keyword',
  function: 'tok-function',
  string: 'tok-string',
  number: 'tok-number',
  operator: 'tok-operator',
};

/**
 * @param {{ textarea: HTMLTextAreaElement, overlayEl: HTMLElement }} ctx
 * @returns {{ refresh: () => void, dispose: () => void }}
 */
export function createSoqlHighlighter(ctx) {
  const { textarea, overlayEl } = ctx;

  /** @type {number | null} */
  let frame = null;

  function render() {
    frame = null;
    // Trailing newline: a <pre> swallows its own, which would drift the overlay
    // up by one line as soon as the query ends with a line break.
    const text = textarea.value + '\n';
    try {
      let html = '';
      for (const token of tokenizeSoql(text)) {
        const slice = win.__escapeHtml(text.slice(token.start, token.end));
        const cls = TOKEN_CLASS[token.kind];
        html += cls ? `<span class="${cls}">${slice}</span>` : slice;
      }
      overlayEl.innerHTML = html;
    } catch {
      // Never leave the overlay empty — the textarea's own text is transparent,
      // so an empty overlay reads as "my query vanished".
      overlayEl.textContent = text;
    }
    syncScroll();
  }

  function syncScroll() {
    overlayEl.scrollTop = textarea.scrollTop;
    overlayEl.scrollLeft = textarea.scrollLeft;
  }

  /** Coalesce bursts of edits into one render per frame. */
  function refresh() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(render);
  }

  textarea.addEventListener('input', refresh);
  textarea.addEventListener('scroll', syncScroll);

  const observer =
    typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => syncScroll()) : null;
  observer?.observe(textarea);

  function dispose() {
    if (frame !== null) cancelAnimationFrame(frame);
    textarea.removeEventListener('input', refresh);
    textarea.removeEventListener('scroll', syncScroll);
    observer?.disconnect();
  }

  render();
  return { refresh, dispose };
}

// @ts-check
/**
 * Build the shared `.input-with-paste` wrapper around a text input / textarea
 * and append a 📋 `.paste-btn`. The delegated click handler in
 * `media/modules/paste-buttons.js` reads the clipboard into the preceding
 * input and fires `input` + `change` events — this helper only builds the DOM.
 *
 * @param {HTMLInputElement | HTMLTextAreaElement} inputEl
 * @param {{ textarea?: boolean }} [opts] - `textarea: true` adds the
 *   `--textarea` modifier (block + relative positioning for the absolute btn).
 * @returns {HTMLDivElement} the wrapper containing the input + paste button.
 */
export function wrapWithPasteButton(inputEl, opts = {}) {
  const wrapper = document.createElement('div');
  wrapper.className = 'input-with-paste' + (opts.textarea ? ' input-with-paste--textarea' : '');

  const pasteBtn = document.createElement('button');
  pasteBtn.type = 'button';
  pasteBtn.className = 'paste-btn';
  pasteBtn.title = 'Paste from clipboard';
  pasteBtn.textContent = '📋';
  pasteBtn.tabIndex = -1;

  // Input must be the paste button's previousElementSibling — the delegated
  // handler relies on that ordering.
  wrapper.appendChild(inputEl);
  wrapper.appendChild(pasteBtn);
  return wrapper;
}

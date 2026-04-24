// @ts-check
// Paste-from-clipboard buttons: clicking any .paste-btn reads clipboard text into
// the immediately preceding <input> or <textarea> and fires input + change events.

(function () {
  document.addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement | null} */ (
      /** @type {HTMLElement} */ (e.target).closest('.paste-btn')
    );
    if (!btn) return;
    const input = /** @type {HTMLInputElement | HTMLTextAreaElement | null} */ (
      btn.previousElementSibling
    );
    if (!input || (input.tagName !== 'INPUT' && input.tagName !== 'TEXTAREA')) return;
    navigator.clipboard
      .readText()
      .then((text) => {
        input.value = text.trim();
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      })
      .catch(() => {});
  });
})();

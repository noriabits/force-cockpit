// @ts-check
/**
 * Shared "Open in editor" / "Copy to clipboard" behaviors for read-only output
 * panes (yaml-scripts log viewer, REST tab response body). Callers own button
 * creation/placement and content extraction — these only wire the click handler.
 */

/**
 * Open `content` in a native plaintext editor tab. Split out of
 * `wireOpenInEditorButton` so a component that renders its own button
 * declaratively has something to call, rather than repeating the route name —
 * `openScriptResult` is a built-in MessageRouter route and works from any tab.
 * @param {string} content
 * @param {{ postMessage: (msg: any) => void }} vscode
 */
export function openContentInEditor(content, vscode) {
  vscode.postMessage({ type: 'openScriptResult', content });
}

/**
 * @param {HTMLButtonElement} button
 * @param {() => string} getContent
 * @param {{ postMessage: (msg: any) => void }} vscode
 */
export function wireOpenInEditorButton(button, getContent, vscode) {
  button.addEventListener('click', () => {
    openContentInEditor(getContent(), vscode);
  });
}

const FEEDBACK_MS = 1500;

/**
 * Buttons currently showing their feedback label, with the label to restore and
 * the pending timer. Needed because the SOQL tab reuses ONE shared button across
 * every cell: without it, a second click during the flash would capture "✓" as
 * the original label and leave the button stuck on it.
 * @type {WeakMap<HTMLButtonElement, { label: string | null, timer: ReturnType<typeof setTimeout> }>}
 */
const flashing = new WeakMap();

/**
 * Copy `text` and flash `feedbackLabel` on the button that triggered it. The one
 * clipboard code path in the webview layer — labelled buttons pass the default,
 * icon buttons (the SOQL tab's column/cell ⧉) pass a '✓' so the flash keeps the
 * button's size. A rejected write (no clipboard permission) is swallowed: the
 * missing feedback is the feedback.
 * @param {HTMLButtonElement} button
 * @param {string} text
 * @param {string} [feedbackLabel]
 */
export function copyTextWithFeedback(button, text, feedbackLabel = 'Copied!') {
  navigator.clipboard
    .writeText(text)
    .then(() => {
      const pending = flashing.get(button);
      if (pending) clearTimeout(pending.timer);
      const label = pending ? pending.label : button.textContent;
      button.textContent = feedbackLabel;
      const timer = setTimeout(() => {
        button.textContent = label;
        flashing.delete(button);
      }, FEEDBACK_MS);
      flashing.set(button, { label, timer });
    })
    .catch(() => {});
}

/**
 * @param {HTMLButtonElement} button
 * @param {() => string} getContent
 */
export function wireCopyToClipboardButton(button, getContent) {
  button.addEventListener('click', () => {
    copyTextWithFeedback(button, getContent());
  });
}

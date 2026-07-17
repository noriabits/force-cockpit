// @ts-check
/**
 * Shared "Open in editor" / "Copy to clipboard" behaviors for read-only output
 * panes (yaml-scripts log viewer, REST tab response body). Callers own button
 * creation/placement and content extraction — these only wire the click handler.
 */

/**
 * @param {HTMLButtonElement} button
 * @param {() => string} getContent
 * @param {{ postMessage: (msg: any) => void }} vscode
 */
export function wireOpenInEditorButton(button, getContent, vscode) {
  button.addEventListener('click', () => {
    vscode.postMessage({ type: 'openScriptResult', content: getContent() });
  });
}

/**
 * @param {HTMLButtonElement} button
 * @param {() => string} getContent
 */
export function wireCopyToClipboardButton(button, getContent) {
  const originalText = button.textContent;
  button.addEventListener('click', () => {
    navigator.clipboard
      .writeText(getContent())
      .then(() => {
        button.textContent = 'Copied!';
        setTimeout(() => {
          button.textContent = originalText;
        }, 1500);
      })
      .catch(() => {});
  });
}

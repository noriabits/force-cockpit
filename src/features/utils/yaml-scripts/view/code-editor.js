// @ts-check
// Plain-textarea code editor widget. Syntax highlighting and line numbers were
// intentionally dropped — for real editing the user opens the code in a native
// VS Code editor (see the "Open in editor" button + the `editScriptCode` route).
// The only affordance kept is Tab → 2 spaces so inline code stays indentable.

/**
 * @param {{ textarea: HTMLTextAreaElement }} opts
 * @returns {{
 *   getContent: () => string,
 *   setContent: (text: string) => void,
 *   setPlaceholder: (text: string) => void,
 *   onInput: (handler: () => void) => void,
 * }}
 */
export function createCodeEditor({ textarea }) {
  // Tab key: insert 2 spaces instead of moving focus (preserves native undo).
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') {
      event.preventDefault();
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const value = textarea.value;
      textarea.value = value.substring(0, start) + '  ' + value.substring(end);
      textarea.selectionStart = textarea.selectionEnd = start + 2;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });

  return {
    getContent: () => textarea.value,
    setContent: (text) => {
      textarea.value = text || '';
    },
    setPlaceholder: (text) => {
      textarea.placeholder = text || '';
    },
    onInput: (handler) => {
      textarea.addEventListener('input', handler);
    },
  };
}

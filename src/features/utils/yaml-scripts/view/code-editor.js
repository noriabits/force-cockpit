// @ts-check
// Self-contained code editor widget: textarea overlaid by a highlight.js-rendered
// <pre><code>, plus a line-number gutter. Syncs scroll, handles Tab indentation,
// throttles highlighting via requestAnimationFrame.

/** @param {'apex' | 'command' | 'js'} type */
function languageForType(type) {
  switch (type) {
    case 'js':
      return 'javascript';
    case 'command':
      return 'bash';
    default:
      return 'apex';
  }
}

/**
 * @param {{
 *   textarea: HTMLTextAreaElement,
 *   codeEl: HTMLElement,
 *   gutter: HTMLElement,
 *   hljs: any,
 * }} opts
 * @returns {{
 *   getContent: () => string,
 *   setContent: (text: string) => void,
 *   setLanguage: (type: 'apex' | 'command' | 'js') => void,
 *   setPlaceholder: (text: string) => void,
 *   onInput: (handler: () => void) => void,
 * }}
 */
export function createCodeEditor({ textarea, codeEl, gutter, hljs }) {
  let currentLang = 'apex';
  /** @type {number | null} */
  let highlightRaf = null;

  function syncHighlight() {
    const text = textarea.value;
    const lineCount = text ? text.split('\n').length : 1;
    const lineNumbers = [];
    for (let lineIdx = 1; lineIdx <= lineCount; lineIdx++) lineNumbers.push(lineIdx);
    gutter.textContent = lineNumbers.join('\n');

    if (highlightRaf !== null) {
      cancelAnimationFrame(highlightRaf);
    }
    highlightRaf = requestAnimationFrame(() => {
      highlightRaf = null;
      if (!text) {
        codeEl.innerHTML = '';
        return;
      }
      const result = hljs.highlight(text + '\n', { language: currentLang });
      codeEl.innerHTML = result.value;
    });
  }

  textarea.addEventListener('input', syncHighlight);
  textarea.addEventListener('scroll', () => {
    const pre = codeEl.parentElement;
    if (pre) {
      pre.scrollTop = textarea.scrollTop;
      pre.scrollLeft = textarea.scrollLeft;
    }
    gutter.scrollTop = textarea.scrollTop;
  });

  // Tab key: insert 2 spaces (preserves native undo)
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') {
      event.preventDefault();
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const value = textarea.value;
      textarea.value = value.substring(0, start) + '  ' + value.substring(end);
      textarea.selectionStart = textarea.selectionEnd = start + 2;
      syncHighlight();
    }
  });

  return {
    getContent: () => textarea.value,
    setContent: (text) => {
      textarea.value = text || '';
      syncHighlight();
    },
    setLanguage: (type) => {
      currentLang = languageForType(type);
      syncHighlight();
    },
    setPlaceholder: (text) => {
      textarea.placeholder = text || '';
    },
    onInput: (handler) => {
      textarea.addEventListener('input', handler);
    },
  };
}

// @ts-check
// Builds the per-script log viewer: status hint, error box, log output with
// the apex-only filter bar (USER_DEBUG + Format JSON checkboxes honoring the
// script's YAML defaults), plus the Open-in-editor and Copy buttons. Factory
// receives a `ctx` so it never reaches into the orchestrator's scope.

/**
 * @typedef {Object} LogViewerRefs
 * @property {HTMLElement} statusHint
 * @property {HTMLElement} errorBox
 * @property {HTMLElement} logViewer
 * @property {HTMLPreElement} logOutput
 * @property {HTMLButtonElement} openInEditorBtn
 * @property {HTMLButtonElement | null} openAsMarkdownBtn
 * @property {HTMLButtonElement} copyToClipboardBtn
 */

/**
 * @typedef {Object} LogViewerCtx
 * @property {any} labels
 * @property {{ postMessage: (msg: any) => void }} vscode
 * @property {(text: string) => string} renderLogWithLinks
 * @property {(text: string) => string} renderLogWithJsonTables
 */

/**
 * @param {LogViewerCtx} ctx
 */
export function createLogViewer(ctx) {
  const { labels, vscode, renderLogWithLinks, renderLogWithJsonTables } = ctx;

  /**
   * @param {HTMLPreElement} logOutput
   * @returns {HTMLButtonElement}
   */
  function buildOpenInEditorButton(logOutput) {
    const button = /** @type {HTMLButtonElement} */ (document.createElement('button'));
    button.className = 'yaml-open-editor-btn';
    button.textContent = 'Open in editor';
    button.style.display = 'none';
    button.addEventListener('click', () => {
      const content = logOutput.textContent || '';
      vscode.postMessage({ type: 'openScriptResult', content });
    });
    return button;
  }

  /**
   * Opens the raw AI output (Markdown source) in VSCode's native Markdown preview.
   * Reads `data-raw-log` rather than `textContent` so the clean Markdown source is
   * used — not the JSON-table-rendered HTML the inline viewer shows for AI scripts.
   * @param {HTMLPreElement} logOutput
   * @param {any} script
   * @returns {HTMLButtonElement}
   */
  function buildOpenAsMarkdownButton(logOutput, script) {
    const button = /** @type {HTMLButtonElement} */ (document.createElement('button'));
    button.className = 'yaml-open-markdown-btn';
    button.textContent = 'Open as markdown';
    button.style.display = 'none';
    button.addEventListener('click', () => {
      const content = logOutput.getAttribute('data-raw-log') || logOutput.textContent || '';
      // Pass scriptId/title so the host can target a stable per-script preview URI.
      vscode.postMessage({
        type: 'openScriptResultMarkdown',
        content,
        scriptId: script.id,
        title: script.name,
      });
    });
    return button;
  }

  /**
   * @param {HTMLPreElement} logOutput
   * @returns {HTMLButtonElement}
   */
  function buildCopyToClipboardButton(logOutput) {
    const button = /** @type {HTMLButtonElement} */ (document.createElement('button'));
    button.className = 'yaml-copy-output-btn';
    button.textContent = 'Copy to clipboard';
    button.style.display = 'none';
    button.addEventListener('click', () => {
      const content = logOutput.textContent || '';
      navigator.clipboard
        .writeText(content)
        .then(() => {
          button.textContent = 'Copied!';
          setTimeout(() => {
            button.textContent = 'Copy to clipboard';
          }, 1500);
        })
        .catch(() => {});
    });
    return button;
  }

  /**
   * @param {any} script
   * @returns {{ fragment: DocumentFragment, refs: LogViewerRefs }}
   */
  function buildLogViewer(script) {
    const fragment = document.createDocumentFragment();
    // Apex shows the USER_DEBUG + Format-JSON filter bar. AI shows only the
    // Format-JSON toggle (default-on, so SOQL records render as a table; the
    // user can untick it to see raw JSON). Command/JS get no filter bar.
    const isApex = script.type === 'apex';
    const isAi = script.type === 'ai';
    const showFilterBar = isApex || isAi;

    const statusHint = document.createElement('span');
    statusHint.className = 'status-hint yaml-status';

    const errorBox = document.createElement('div');
    errorBox.className = 'error-box';

    const logViewer = document.createElement('div');
    logViewer.className = 'yaml-log-viewer';
    logViewer.style.display = 'none';

    const logOutput = /** @type {HTMLPreElement} */ (document.createElement('pre'));
    logOutput.className = 'yaml-log-output';
    logOutput.addEventListener('click', (event) => {
      const target = /** @type {HTMLElement} */ (event.target);
      if (target.tagName === 'A' && target.classList.contains('yaml-log-link')) {
        event.preventDefault();
        const url = target.getAttribute('data-url');
        if (url) {
          vscode.postMessage({ type: 'openExternalUrl', url });
        }
      }
    });

    if (showFilterBar) {
      const filterBar = document.createElement('div');
      filterBar.className = 'yaml-log-filter-bar';

      // USER_DEBUG-only filter — apex scripts only (AI output has no debug log).
      /** @type {HTMLInputElement | null} */
      let filterCheckbox = null;
      if (isApex) {
        filterCheckbox = document.createElement('input');
        filterCheckbox.type = 'checkbox';
        filterCheckbox.className = 'yaml-log-filter-checkbox';
        filterCheckbox.checked = !!(script.filterUserDebug || script.formatJson);
        const filterLabel = document.createElement('label');
        filterLabel.className = 'yaml-log-filter-label';
        filterLabel.appendChild(filterCheckbox);
        filterLabel.appendChild(document.createTextNode(labels.checkboxUserDebugOnly));
        filterBar.appendChild(filterLabel);
      }

      const jsonCheckbox = document.createElement('input');
      jsonCheckbox.type = 'checkbox';
      jsonCheckbox.className = 'yaml-log-json-checkbox';
      // Default-on for AI so SOQL records render as a table out of the box.
      jsonCheckbox.checked = isAi ? true : (script.formatJson ?? false);
      const jsonLabel = document.createElement('label');
      jsonLabel.className = 'yaml-log-filter-label';
      jsonLabel.appendChild(jsonCheckbox);
      jsonLabel.appendChild(document.createTextNode(labels.checkboxPrettyJson));

      function refresh() {
        const raw = logOutput.getAttribute('data-raw-log') ?? '';
        const filtered = logOutput.getAttribute('data-filtered-log') ?? '';
        const text = filterCheckbox?.checked && filtered ? filtered : raw;
        logOutput.innerHTML = jsonCheckbox.checked
          ? renderLogWithJsonTables(text)
          : renderLogWithLinks(text);
      }

      jsonCheckbox.addEventListener('change', () => {
        // Apex: Format JSON operates on the USER_DEBUG-filtered view, so ticking
        // it implies the filter. AI has no filter checkbox — nothing to couple.
        if (jsonCheckbox.checked && filterCheckbox && !filterCheckbox.checked) {
          filterCheckbox.checked = true;
        }
        refresh();
      });
      filterCheckbox?.addEventListener('change', refresh);

      filterBar.appendChild(jsonLabel);
      logViewer.appendChild(filterBar);
    }

    logViewer.appendChild(logOutput);

    const openInEditorBtn = buildOpenInEditorButton(logOutput);
    logViewer.appendChild(openInEditorBtn);

    // AI scripts emit Markdown — offer to open the raw output in VSCode's
    // native Markdown preview. Other script types don't get this button.
    const openAsMarkdownBtn = isAi ? buildOpenAsMarkdownButton(logOutput, script) : null;
    if (openAsMarkdownBtn) logViewer.appendChild(openAsMarkdownBtn);

    const copyToClipboardBtn = buildCopyToClipboardButton(logOutput);
    logViewer.appendChild(copyToClipboardBtn);

    fragment.appendChild(statusHint);
    fragment.appendChild(errorBox);
    fragment.appendChild(logViewer);

    return {
      fragment,
      refs: {
        statusHint,
        errorBox,
        logViewer,
        logOutput,
        openInEditorBtn,
        openAsMarkdownBtn,
        copyToClipboardBtn,
      },
    };
  }

  return { buildLogViewer };
}

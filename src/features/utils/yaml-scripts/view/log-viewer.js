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
    const isApex = script.type !== 'command' && script.type !== 'js';

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

    if (isApex) {
      const filterBar = document.createElement('div');
      filterBar.className = 'yaml-log-filter-bar';

      const filterCheckbox = document.createElement('input');
      filterCheckbox.type = 'checkbox';
      filterCheckbox.className = 'yaml-log-filter-checkbox';
      filterCheckbox.checked = !!(script.filterUserDebug || script.formatJson);
      const filterLabel = document.createElement('label');
      filterLabel.className = 'yaml-log-filter-label';
      filterLabel.appendChild(filterCheckbox);
      filterLabel.appendChild(document.createTextNode(labels.checkboxUserDebugOnly));

      const jsonCheckbox = document.createElement('input');
      jsonCheckbox.type = 'checkbox';
      jsonCheckbox.className = 'yaml-log-json-checkbox';
      jsonCheckbox.checked = script.formatJson ?? false;
      const jsonLabel = document.createElement('label');
      jsonLabel.className = 'yaml-log-filter-label';
      jsonLabel.appendChild(jsonCheckbox);
      jsonLabel.appendChild(document.createTextNode(labels.checkboxPrettyJson));

      function refresh() {
        const raw = logOutput.getAttribute('data-raw-log') ?? '';
        const filtered = logOutput.getAttribute('data-filtered-log') ?? '';
        const text = filterCheckbox.checked && filtered ? filtered : raw;
        logOutput.innerHTML = jsonCheckbox.checked
          ? renderLogWithJsonTables(text)
          : renderLogWithLinks(text);
      }

      filterCheckbox.addEventListener('change', refresh);
      jsonCheckbox.addEventListener('change', () => {
        if (jsonCheckbox.checked && !filterCheckbox.checked) {
          filterCheckbox.checked = true;
        }
        refresh();
      });

      filterBar.appendChild(filterLabel);
      filterBar.appendChild(jsonLabel);
      logViewer.appendChild(filterBar);
    }

    logViewer.appendChild(logOutput);

    const openInEditorBtn = buildOpenInEditorButton(logOutput);
    logViewer.appendChild(openInEditorBtn);

    const copyToClipboardBtn = buildCopyToClipboardButton(logOutput);
    logViewer.appendChild(copyToClipboardBtn);

    fragment.appendChild(statusHint);
    fragment.appendChild(errorBox);
    fragment.appendChild(logViewer);

    return {
      fragment,
      refs: { statusHint, errorBox, logViewer, logOutput, openInEditorBtn, copyToClipboardBtn },
    };
  }

  return { buildLogViewer };
}

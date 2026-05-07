// @ts-check
// Builds the per-script accordion section (header + body + log viewer) and
// wires its execute handler. Depends on a small `ctx` object so it never
// reaches into the orchestrator's module scope directly.

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
 * @typedef {Object} AccordionBuilderCtx
 * @property {any} labels
 * @property {HTMLElement} scriptsList
 * @property {Set<string>} favoriteIds
 * @property {Map<string, string>} opIdToScriptId
 * @property {Map<string, () => void>} executeStateUpdaters
 * @property {() => boolean} getConnected
 * @property {() => any} getCurrentOrgData
 * @property {(script: any) => void} onEditClick
 * @property {{ postMessage: (msg: any) => void }} vscode
 * @property {(btn: HTMLButtonElement, onCancel: () => void) => string | null} startAction
 * @property {(orgData: any, prompt: string, onConfirmed: () => void, onCancelled?: () => void) => void} confirmIfSensitive
 * @property {(str: string) => string} escapeHtml
 * @property {(text: string) => string} renderLogWithLinks
 * @property {(text: string) => string} renderLogWithJsonTables
 */

/**
 * @param {AccordionBuilderCtx} ctx
 */
export function createAccordionBuilder(ctx) {
  const {
    labels,
    scriptsList,
    favoriteIds,
    opIdToScriptId,
    executeStateUpdaters,
    getConnected,
    getCurrentOrgData,
    onEditClick,
    vscode,
    startAction,
    confirmIfSensitive,
    escapeHtml,
    renderLogWithLinks,
    renderLogWithJsonTables,
  } = ctx;

  /** @param {any} script @returns {HTMLButtonElement} */
  function createFavoriteButton(script) {
    const isFav = favoriteIds.has(script.id);
    const button = /** @type {HTMLButtonElement} */ (document.createElement('button'));
    button.className = 'btn yaml-star-btn' + (isFav ? ' yaml-star-btn--active' : '');
    button.textContent = isFav ? '★' : '☆';
    button.title = isFav ? labels.unfavorite : labels.favorite;
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      vscode.postMessage({ type: 'toggleFavorite', scriptId: script.id });
    });
    return button;
  }

  function updateFavoriteStars() {
    scriptsList.querySelectorAll('.accordion').forEach((accordion) => {
      const scriptId = accordion.getAttribute('data-script-id');
      const starBtn = /** @type {HTMLButtonElement | null} */ (
        accordion.querySelector('.yaml-star-btn')
      );
      if (!starBtn || !scriptId) return;
      const isFav = favoriteIds.has(scriptId);
      starBtn.textContent = isFav ? '★' : '☆';
      starBtn.className = 'btn yaml-star-btn' + (isFav ? ' yaml-star-btn--active' : '');
      starBtn.title = isFav ? labels.unfavorite : labels.favorite;
    });
  }

  /**
   * @param {any} script
   * @param {string} [extraClasses]
   * @returns {HTMLElement}
   */
  function createAccordionSection(script, extraClasses) {
    const section = document.createElement('section');
    section.className = extraClasses ? `accordion ${extraClasses}` : 'accordion';
    section.setAttribute('data-script-id', script.id);
    if (script.type) section.setAttribute('data-script-type', script.type);
    section.setAttribute('data-folder', script.folder);
    section.setAttribute('data-source', script.source ?? 'user');
    section.setAttribute('data-search-text', `${script.name} ${script.description}`.toLowerCase());
    return section;
  }

  /**
   * @param {any} script
   * @param {HTMLElement} section
   * @returns {HTMLButtonElement}
   */
  function createTriggerButton(script, section) {
    const trigger = /** @type {HTMLButtonElement} */ (document.createElement('button'));
    trigger.className = 'accordion-trigger';
    trigger.innerHTML = `
      <span class="accordion-icon">&#9656;</span>
      <span class="accordion-title">${escapeHtml(script.name)}</span>
    `;
    if (script.description || script.scriptFile) {
      const subtitleSpan = document.createElement('span');
      subtitleSpan.className = 'accordion-subtitle';
      if (script.description) {
        subtitleSpan.appendChild(document.createTextNode(script.description));
      }
      if (script.scriptFile) {
        if (script.description) subtitleSpan.appendChild(document.createTextNode('  '));
        const fileLink = document.createElement('button');
        fileLink.type = 'button';
        fileLink.className = 'yaml-file-link';
        fileLink.textContent = `📄 ${script.scriptFile}`;
        fileLink.title = 'Open file in editor';
        fileLink.addEventListener('click', (event) => {
          event.stopPropagation();
          vscode.postMessage({ type: 'openScriptFile', filePath: script.scriptFile });
        });
        subtitleSpan.appendChild(fileLink);
      }
      trigger.appendChild(subtitleSpan);
    }
    trigger.addEventListener('click', () => section.classList.toggle('open'));
    return trigger;
  }

  /** @returns {HTMLElement} */
  function createPrivateBadge() {
    const badge = document.createElement('span');
    badge.className = 'private-badge';
    badge.textContent = labels.badgePrivate;
    badge.title = labels.labelPrivate;
    return badge;
  }

  /** @param {any} script @returns {HTMLButtonElement} */
  function createEditButton(script) {
    const button = /** @type {HTMLButtonElement} */ (document.createElement('button'));
    button.className = 'btn yaml-edit-btn';
    button.textContent = labels.btnEdit;
    button.title = labels.tooltipEditScript;
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      onEditClick(script);
    });
    return button;
  }

  /** @param {any} script @returns {HTMLElement} */
  function createTypeBadge(script) {
    const isJs = script.type === 'js';
    const isCmd = script.type === 'command';
    const span = document.createElement('span');
    span.className =
      'script-type-badge ' +
      (isJs
        ? 'script-type-badge--js'
        : isCmd
          ? 'script-type-badge--command'
          : 'script-type-badge--apex');
    span.textContent = isJs ? labels.badgeJs : isCmd ? labels.badgeCommand : labels.badgeApex;
    return span;
  }

  /** @param {any} script @returns {HTMLElement} */
  function buildInvalidAccordion(script) {
    const section = createAccordionSection(script, 'open yaml-script--invalid');
    const header = document.createElement('div');
    header.className = 'yaml-script-header';

    header.appendChild(createTriggerButton(script, section));
    header.appendChild(createFavoriteButton(script));

    const invalidBadge = document.createElement('span');
    invalidBadge.className = 'script-invalid-badge';
    invalidBadge.textContent = labels.badgeInvalid;
    header.appendChild(invalidBadge);

    if (script.source === 'private') header.appendChild(createPrivateBadge());
    header.appendChild(createEditButton(script));

    const executeBtn = document.createElement('button');
    executeBtn.className = 'btn yaml-execute-btn';
    executeBtn.textContent = labels.btnExecute;
    executeBtn.disabled = true;
    executeBtn.title = labels.tooltipInvalidScript;
    header.appendChild(executeBtn);

    const body = document.createElement('div');
    body.className = 'accordion-body';
    const errorBox = document.createElement('div');
    errorBox.className = 'error-box';
    errorBox.textContent = script.error ?? labels.badgeInvalid;
    body.appendChild(errorBox);

    section.appendChild(header);
    section.appendChild(body);
    return section;
  }

  /**
   * @param {any} script
   * @param {() => void} updateExecuteState
   * @returns {{ element: HTMLElement | null, inputFields: Map<string, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement> }}
   */
  function buildInputFields(script, updateExecuteState) {
    /** @type {Map<string, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>} */
    const inputFields = new Map();
    if (!script.inputs || script.inputs.length === 0) {
      return { element: null, inputFields };
    }

    const inputsForm = document.createElement('div');
    inputsForm.className = 'yaml-inputs-form';

    for (const input of script.inputs) {
      const fieldDiv = document.createElement('div');
      fieldDiv.className = 'yaml-input-field';

      if (input.type === 'checkbox') {
        const checkboxLabel = document.createElement('label');
        checkboxLabel.className = 'yaml-input-checkbox-label';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = input.default === true;
        checkbox.addEventListener('change', updateExecuteState);
        inputFields.set(input.name, checkbox);
        const span = document.createElement('span');
        span.textContent = input.label || input.name;
        checkboxLabel.appendChild(checkbox);
        checkboxLabel.appendChild(span);
        fieldDiv.appendChild(checkboxLabel);
      } else {
        const label = document.createElement('label');
        label.className = 'form-label';
        label.textContent = input.label || input.name;
        if (input.required) {
          const reqStar = document.createElement('span');
          reqStar.className = 'yaml-input-required-star';
          reqStar.textContent = ' *';
          label.appendChild(reqStar);
        }
        fieldDiv.appendChild(label);

        if (input.type === 'picklist' && input.options && input.options.length > 0) {
          const select = document.createElement('select');
          select.className = 'text-input';
          for (const opt of input.options) {
            const option = document.createElement('option');
            option.value = opt;
            option.textContent = opt;
            select.appendChild(option);
          }
          select.addEventListener('change', updateExecuteState);
          inputFields.set(input.name, select);
          fieldDiv.appendChild(select);
        } else if (input.type === 'textarea') {
          const textarea = document.createElement('textarea');
          textarea.className = 'text-input yaml-input-textarea';
          textarea.placeholder = input.label || input.name;
          textarea.rows = 4;
          textarea.addEventListener('input', updateExecuteState);
          textarea.addEventListener('paste', (event) => {
            event.preventDefault();
            const text = (event.clipboardData?.getData('text') ?? '').trim();
            const start = textarea.selectionStart ?? textarea.value.length;
            const end = textarea.selectionEnd ?? textarea.value.length;
            textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
            textarea.selectionStart = textarea.selectionEnd = start + text.length;
            updateExecuteState();
          });
          inputFields.set(input.name, textarea);
          const pasteWrapper = document.createElement('div');
          pasteWrapper.className = 'input-with-paste input-with-paste--textarea';
          const pasteBtn = document.createElement('button');
          pasteBtn.type = 'button';
          pasteBtn.className = 'paste-btn';
          pasteBtn.title = 'Paste from clipboard';
          pasteBtn.textContent = '📋';
          pasteBtn.tabIndex = -1;
          pasteBtn.addEventListener('click', () => {
            navigator.clipboard
              .readText()
              .then((text) => {
                textarea.value = text.trim();
                updateExecuteState();
              })
              .catch(() => {});
          });
          pasteWrapper.appendChild(textarea);
          pasteWrapper.appendChild(pasteBtn);
          fieldDiv.appendChild(pasteWrapper);
        } else {
          const textInput = document.createElement('input');
          textInput.type = 'text';
          textInput.className = 'text-input';
          textInput.placeholder = input.label || input.name;
          textInput.addEventListener('input', updateExecuteState);
          textInput.addEventListener('paste', (event) => {
            event.preventDefault();
            const text = (event.clipboardData?.getData('text') ?? '').trim();
            const start = textInput.selectionStart ?? textInput.value.length;
            const end = textInput.selectionEnd ?? textInput.value.length;
            textInput.value = textInput.value.slice(0, start) + text + textInput.value.slice(end);
            textInput.selectionStart = textInput.selectionEnd = start + text.length;
            updateExecuteState();
          });
          inputFields.set(input.name, textInput);
          const pasteWrapper = document.createElement('div');
          pasteWrapper.className = 'input-with-paste';
          const pasteBtn = document.createElement('button');
          pasteBtn.type = 'button';
          pasteBtn.className = 'paste-btn';
          pasteBtn.title = 'Paste from clipboard';
          pasteBtn.textContent = '📋';
          pasteBtn.tabIndex = -1;
          pasteBtn.addEventListener('click', () => {
            navigator.clipboard
              .readText()
              .then((text) => {
                textInput.value = text.trim();
                updateExecuteState();
              })
              .catch(() => {});
          });
          pasteWrapper.appendChild(textInput);
          pasteWrapper.appendChild(pasteBtn);
          fieldDiv.appendChild(pasteWrapper);
        }
      }

      inputsForm.appendChild(fieldDiv);
    }

    return { element: inputsForm, inputFields };
  }

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

  /**
   * @param {{
   *   script: any,
   *   section: HTMLElement,
   *   executeBtn: HTMLButtonElement,
   *   needsOrg: boolean,
   *   inputFields: Map<string, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>,
   *   refs: LogViewerRefs,
   * }} params
   */
  function attachExecuteHandler({ script, section, executeBtn, needsOrg, inputFields, refs }) {
    const { statusHint, errorBox, logViewer, logOutput, openInEditorBtn, copyToClipboardBtn } =
      refs;

    executeBtn.addEventListener('click', () => {
      if (needsOrg && !getConnected()) return;

      /** @type {Record<string, string>} */
      const inputValues = {};
      inputFields.forEach((field, name) => {
        if (field instanceof HTMLInputElement && field.type === 'checkbox') {
          inputValues[name] = field.checked ? 'true' : 'false';
        } else {
          inputValues[name] = field.value.trim();
        }
      });

      /** @type {string | null} */
      let scriptOpId = null;

      function doExecute() {
        statusHint.textContent = labels.statusExecuting;
        errorBox.textContent = '';
        logViewer.style.display = 'block';
        logOutput.textContent = '';
        logOutput.removeAttribute('data-raw-log');
        logOutput.removeAttribute('data-filtered-log');
        logOutput.classList.remove('yaml-log-output--success', 'yaml-log-output--error');
        openInEditorBtn.style.display = 'none';
        copyToClipboardBtn.style.display = 'none';

        const filterCheckbox = /** @type {HTMLInputElement | null} */ (
          section.querySelector('.yaml-log-filter-checkbox')
        );
        if (filterCheckbox) {
          filterCheckbox.checked = !!(script.filterUserDebug || script.formatJson);
        }
        const jsonCheckbox = /** @type {HTMLInputElement | null} */ (
          section.querySelector('.yaml-log-json-checkbox')
        );
        if (jsonCheckbox) jsonCheckbox.checked = script.formatJson ?? false;

        section.classList.add('open');
        scriptOpId = startAction(executeBtn, () => {
          statusHint.textContent = '';
          vscode.postMessage({ type: 'cancelOperation', opId: scriptOpId });
        });
        if (scriptOpId) opIdToScriptId.set(scriptOpId, script.id);
        vscode.postMessage({
          type: 'executeYamlScript',
          scriptId: script.id,
          inputs: inputValues,
          opId: scriptOpId,
        });
      }

      confirmIfSensitive(getCurrentOrgData(), 'Execute this script?', doExecute, () => {});
    });
  }

  /** @param {any} script @returns {HTMLElement} */
  function buildAccordion(script) {
    if (script.invalid) return buildInvalidAccordion(script);

    const isCommand = script.type === 'command';
    const isJs = script.type === 'js';
    const needsOrg = !isCommand && !isJs;

    const section = createAccordionSection(script);

    // ── Header ──
    const header = document.createElement('div');
    header.className = 'yaml-script-header';

    const executeBtn = /** @type {HTMLButtonElement} */ (document.createElement('button'));
    executeBtn.className = 'btn btn-primary yaml-execute-btn';
    executeBtn.textContent = labels.btnExecute;
    executeBtn.disabled = needsOrg ? !getConnected() : false;

    header.appendChild(createTriggerButton(script, section));
    header.appendChild(createFavoriteButton(script));
    header.appendChild(createTypeBadge(script));
    if (script.source === 'private') header.appendChild(createPrivateBadge());
    if (script.source !== 'builtin') header.appendChild(createEditButton(script));
    header.appendChild(executeBtn);

    // ── Body ──
    const body = document.createElement('div');
    body.className = 'accordion-body';

    const hasInputs = script.inputs && script.inputs.length > 0;

    function updateExecuteState() {
      const orgOk = needsOrg ? getConnected() : true;
      if (!hasInputs) {
        executeBtn.disabled = !orgOk;
        return;
      }
      const allRequiredFilled = (script.inputs || []).every((/** @type {any} */ input) => {
        if (!input.required) return true;
        const field = inputFields.get(input.name);
        if (!field) return false;
        if (field instanceof HTMLInputElement && field.type === 'checkbox') return true;
        return field.value.trim() !== '';
      });
      executeBtn.disabled = !(orgOk && allRequiredFilled);
    }

    const { element: inputsEl, inputFields } = buildInputFields(script, updateExecuteState);
    if (inputsEl) body.appendChild(inputsEl);
    executeStateUpdaters.set(script.id, updateExecuteState);

    if (hasInputs && (script.inputs || []).some((/** @type {any} */ input) => input.required)) {
      executeBtn.disabled = true;
    }

    const { fragment, refs } = buildLogViewer(script);
    body.appendChild(fragment);

    section.appendChild(header);
    section.appendChild(body);

    attachExecuteHandler({ script, section, executeBtn, needsOrg, inputFields, refs });

    return section;
  }

  return { buildAccordion, updateFavoriteStars };
}

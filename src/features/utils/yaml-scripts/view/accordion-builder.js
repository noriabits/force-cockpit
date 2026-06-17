// @ts-check
// Builds the per-script accordion section: header (favorite star, trigger,
// badges, edit button), execution input fields and the body composition. The
// log viewer and execute handler are injected factories (log-viewer.js /
// execute-handler.js) so this module stays focused on structure. Depends on
// a small `ctx` object so it never reaches into the orchestrator's module
// scope directly.
import { wrapWithPasteButton } from '../../../shared/view/paste-input.js';

/** @typedef {import('./log-viewer.js').LogViewerRefs} LogViewerRefs */

/**
 * @typedef {Object} AccordionBuilderCtx
 * @property {any} labels
 * @property {HTMLElement} scriptsList
 * @property {Set<string>} favoriteIds
 * @property {Map<string, () => void>} executeStateUpdaters
 * @property {() => boolean} getConnected
 * @property {(script: any) => void} onEditClick
 * @property {(script: any) => void} onOpenYamlClick
 * @property {{ postMessage: (msg: any) => void }} vscode
 * @property {(str: string) => string} escapeHtml
 * @property {(script: any) => { fragment: DocumentFragment, refs: LogViewerRefs }} buildLogViewer
 * @property {(params: {
 *   script: any,
 *   section: HTMLElement,
 *   executeBtn: HTMLButtonElement,
 *   needsOrg: boolean,
 *   inputFields: Map<string, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>,
 *   refs: LogViewerRefs,
 * }) => void} attachExecuteHandler
 */

/**
 * @param {AccordionBuilderCtx} ctx
 */
export function createAccordionBuilder(ctx) {
  const {
    labels,
    scriptsList,
    favoriteIds,
    executeStateUpdaters,
    getConnected,
    onEditClick,
    onOpenYamlClick,
    vscode,
    escapeHtml,
    buildLogViewer,
    attachExecuteHandler,
  } = ctx;

  /**
   * Custom tooltips: native `title` tooltips don't render in VS Code webviews,
   * so header icon buttons opt into the shared body-appended tooltip via the
   * global `win.__setTooltip` helper (media/modules/tooltip.js).
   * @param {HTMLElement} el
   * @param {string} text
   */
  function setTooltip(el, text) {
    /** @type {any} */ (window).__setTooltip(el, text);
  }

  /** @param {any} script @returns {HTMLButtonElement} */
  function createFavoriteButton(script) {
    const isFav = favoriteIds.has(script.id);
    const button = /** @type {HTMLButtonElement} */ (document.createElement('button'));
    button.className = 'btn yaml-star-btn' + (isFav ? ' yaml-star-btn--active' : '');
    button.textContent = isFav ? '★' : '☆';
    setTooltip(button, isFav ? labels.unfavorite : labels.favorite);
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
      setTooltip(starBtn, isFav ? labels.unfavorite : labels.favorite);
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
        setTooltip(fileLink, 'Open file in editor');
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
    setTooltip(badge, labels.labelPrivate);
    return badge;
  }

  /** @param {any} script @returns {HTMLButtonElement} */
  function createEditButton(script) {
    const button = /** @type {HTMLButtonElement} */ (document.createElement('button'));
    button.className = 'btn yaml-edit-btn';
    button.textContent = labels.btnEdit;
    setTooltip(button, labels.tooltipEditScript);
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      onEditClick(script);
    });
    return button;
  }

  /** @param {any} script @returns {HTMLButtonElement} */
  function createOpenYamlButton(script) {
    const button = /** @type {HTMLButtonElement} */ (document.createElement('button'));
    button.className = 'btn yaml-open-yaml-btn';
    button.textContent = '📄';
    setTooltip(button, labels.tooltipOpenYaml);
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      onOpenYamlClick(script);
    });
    return button;
  }

  /** @param {any} script @returns {HTMLElement} */
  function createTypeBadge(script) {
    /** @type {Record<string, { cls: string; text: string }>} */
    const byType = {
      js: { cls: 'script-type-badge--js', text: labels.badgeJs },
      command: { cls: 'script-type-badge--command', text: labels.badgeCommand },
      ai: { cls: 'script-type-badge--ai', text: labels.badgeAi },
      apex: { cls: 'script-type-badge--apex', text: labels.badgeApex },
    };
    const meta = byType[script.type] || byType.apex;
    const span = document.createElement('span');
    span.className = 'script-type-badge ' + meta.cls;
    span.textContent = meta.text;
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
    header.appendChild(createOpenYamlButton(script));

    const executeBtn = document.createElement('button');
    executeBtn.className = 'btn yaml-execute-btn';
    executeBtn.textContent = labels.btnExecute;
    executeBtn.disabled = true;
    setTooltip(executeBtn, labels.tooltipInvalidScript);
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
          fieldDiv.appendChild(wrapWithPasteButton(textarea, { textarea: true }));
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
          fieldDiv.appendChild(wrapWithPasteButton(textInput));
        }
      }

      inputsForm.appendChild(fieldDiv);
    }

    return { element: inputsForm, inputFields };
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
    if (script.source !== 'builtin') {
      header.appendChild(createEditButton(script));
      header.appendChild(createOpenYamlButton(script));
    }
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

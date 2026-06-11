// @ts-check
import { renderLogWithLinks, renderLogWithJsonTables } from './log-rendering.js';
import { createCodeEditor } from './code-editor.js';
import { createFormInputsEditor } from './form-inputs-editor.js';
import { createAccordionBuilder } from './accordion-builder.js';
import { createCategoryFilterBar } from '../../../shared/view/category-filter-bar.js';
import { createFolderCombobox } from '../../../shared/view/folder-combobox.js';
import { applyListFilter } from '../../../shared/view/list-filter';
import { scrollAndHighlight } from '../../../shared/view/scroll-highlight.js';

(function () {
  const win = /** @type {any} */ (window);
  const L = win.YamlScriptsLabels;

  const searchInput = /** @type {HTMLInputElement} */ (document.getElementById('yaml-search'));
  const refreshBtn = /** @type {HTMLButtonElement} */ (document.getElementById('yaml-refresh-btn'));
  const pillsContainer = /** @type {HTMLElement} */ (document.getElementById('yaml-folder-pills'));
  const subPillsEl = /** @type {HTMLElement} */ (document.getElementById('yaml-sub-pills'));
  const visibilityFilterEl = /** @type {HTMLElement} */ (
    document.getElementById('yaml-visibility-filter')
  );
  const scriptsList = /** @type {HTMLElement} */ (document.getElementById('yaml-scripts-list'));

  /** @type {Map<string, string>} Maps opId → scriptId for in-flight executions */
  const opIdToScriptId = new Map();
  /** @type {Map<string, string>} Maps opId → accumulated log text (memory-based, not DOM) */
  const scriptLogContent = new Map();
  const noResults = /** @type {HTMLElement} */ (document.getElementById('yaml-no-results'));
  const loadError = /** @type {HTMLElement} */ (document.getElementById('yaml-load-error'));

  // ── New Script form refs ───────────────────────────────────────────────────
  const newBtn = /** @type {HTMLButtonElement} */ (document.getElementById('yaml-new-btn'));
  const newForm = /** @type {HTMLElement} */ (document.getElementById('yaml-new-form'));
  const formName = /** @type {HTMLInputElement} */ (document.getElementById('yaml-form-name'));
  const formDescription = /** @type {HTMLTextAreaElement} */ (
    document.getElementById('yaml-form-description')
  );
  const formType = /** @type {HTMLSelectElement} */ (document.getElementById('yaml-form-type'));
  const formFolder = /** @type {HTMLInputElement} */ (document.getElementById('yaml-form-folder'));
  const folderToggle = /** @type {HTMLButtonElement} */ (
    document.getElementById('yaml-folder-toggle')
  );
  const folderDropdown = /** @type {HTMLElement} */ (
    document.getElementById('yaml-folder-dropdown')
  );
  const formContent = /** @type {HTMLTextAreaElement} */ (
    document.getElementById('yaml-form-content')
  );
  const highlightCode = /** @type {HTMLElement} */ (document.getElementById('yaml-highlight-code'));
  const gutter = /** @type {HTMLElement} */ (document.getElementById('yaml-code-gutter'));
  const formSource = /** @type {HTMLSelectElement} */ (document.getElementById('yaml-form-source'));
  const formFileRow = /** @type {HTMLElement} */ (document.getElementById('yaml-form-file-row'));
  const formFilePath = /** @type {HTMLInputElement} */ (
    document.getElementById('yaml-form-file-path')
  );
  const formBrowseBtn = /** @type {HTMLButtonElement} */ (
    document.getElementById('yaml-form-browse-btn')
  );
  const formPrivate = /** @type {HTMLInputElement} */ (
    document.getElementById('yaml-form-private')
  );
  const formPrivateLabel = /** @type {HTMLElement} */ (
    document.getElementById('yaml-form-private-label')
  );
  const formError = /** @type {HTMLElement} */ (document.getElementById('yaml-form-error'));
  const formSaveBtn = /** @type {HTMLButtonElement} */ (
    document.getElementById('yaml-form-save-btn')
  );
  const formCancelBtn = /** @type {HTMLButtonElement} */ (
    document.getElementById('yaml-form-cancel-btn')
  );
  const formDeleteBtn = /** @type {HTMLButtonElement} */ (
    document.getElementById('yaml-form-delete-btn')
  );

  // ── Apex default output settings refs ────────────────────────────────────
  const formApexDefaultsRow = /** @type {HTMLElement} */ (
    document.getElementById('yaml-form-apex-defaults-row')
  );
  const formFilterUserDebug = /** @type {HTMLInputElement} */ (
    document.getElementById('yaml-form-filter-user-debug')
  );
  const formFormatJson = /** @type {HTMLInputElement} */ (
    document.getElementById('yaml-form-format-json')
  );

  // ── Inputs form refs ──────────────────────────────────────────────────────
  const formInputsList = /** @type {HTMLElement} */ (
    document.getElementById('yaml-form-inputs-list')
  );
  const addInputBtn = /** @type {HTMLButtonElement} */ (
    document.getElementById('yaml-add-input-btn')
  );
  const formInputsLabel = /** @type {HTMLElement} */ (
    document.getElementById('yaml-form-inputs-label')
  );

  // Hide form immediately via JS — the CSP blocks inline style="display:none" attributes
  newForm.style.display = 'none';
  formDeleteBtn.style.display = 'none';
  formFileRow.style.display = 'none';

  // ── Textarea + highlight.js editor ──────────────────────────────────────
  const editor = createCodeEditor({
    textarea: formContent,
    codeEl: highlightCode,
    gutter,
    hljs: win.hljs,
  });

  let connected = false;
  /** @type {any} */
  let currentOrgData = null;
  /** @type {string | null} */
  let lastConnectedOrgId = null;
  // Mutated in place (never reassigned) — accordion-builder and the filter bar
  // capture this reference at creation time
  /** @type {Set<string>} */
  const favoriteIds = new Set();
  /** @type {string | null} */
  let lastSavedScriptId = null;
  /** @type {string | null} */
  let editingScriptId = null;
  /** @type {string | null} */
  let editingScriptSource = null;
  /** @type {{ id: string; folder: string; name: string; description: string; type: 'apex' | 'command' | 'js'; script: string; scriptFile?: string; source: string; invalid?: true; error?: string; filterUserDebug?: boolean; formatJson?: boolean; inputs?: Array<{ name: string; label?: string; type?: 'string' | 'picklist' | 'checkbox'; required?: boolean; options?: string[]; default?: boolean }> }[]} */
  let currentScripts = [];

  /** @type {Map<string, () => void>} */
  const executeStateUpdaters = new Map();

  // ── Init static text from labels ──────────────────────────────────────────

  newBtn.textContent = L.btnNewScript;
  formSaveBtn.textContent = L.btnSave;
  formCancelBtn.textContent = L.btnCancel;
  formType.options[0].text = L.typeApex;
  formType.options[1].text = L.typeCommand;
  formType.options[2].text = L.typeJs;
  const labelName = document.querySelector('label[for="yaml-form-name"]');
  const labelDescription = document.querySelector('label[for="yaml-form-description"]');
  const labelType = document.querySelector('label[for="yaml-form-type"]');
  const labelFolder = document.querySelector('label[for="yaml-form-folder"]');
  const labelContent = document.getElementById('yaml-form-content-label');
  if (labelName) labelName.textContent = L.labelName;
  if (labelDescription) labelDescription.textContent = L.labelDescription;
  if (labelType) labelType.textContent = L.labelType;
  if (labelFolder) labelFolder.textContent = L.labelFolder;
  if (labelContent) labelContent.textContent = L.labelContent;
  formName.placeholder = L.placeholderName;
  formDescription.placeholder = L.placeholderDescription;
  formFolder.placeholder = L.placeholderFolder;
  if (formInputsLabel) formInputsLabel.textContent = L.labelInputs;
  addInputBtn.textContent = L.btnAddInput;
  formSource.options[0].text = L.sourceInline;
  formSource.options[1].text = L.sourceFile;
  const labelSource = document.querySelector('label[for="yaml-form-source"]');
  if (labelSource) labelSource.textContent = L.labelSource;
  const labelFilePath = document.querySelector('label[for="yaml-form-file-path"]');
  if (labelFilePath) labelFilePath.textContent = L.labelFilePath;
  formFilePath.placeholder = L.placeholderFilePath;
  formBrowseBtn.textContent = L.btnBrowse;
  if (formPrivateLabel) formPrivateLabel.textContent = L.labelPrivate;
  const apexDefaultsLabel = document.getElementById('yaml-form-apex-defaults-label');
  const filterUserDebugLabel = document.getElementById('yaml-form-filter-user-debug-label');
  const formatJsonLabel = document.getElementById('yaml-form-format-json-label');
  if (apexDefaultsLabel) apexDefaultsLabel.textContent = L.labelDefaultOutputSettings;
  if (filterUserDebugLabel) filterUserDebugLabel.textContent = L.labelDefaultFilterUserDebug;
  if (formatJsonLabel) formatJsonLabel.textContent = L.labelDefaultFormatJson;

  // ── Category/visibility filter bar (shared module) ────────────────────────

  const filterBar = createCategoryFilterBar({
    visibilityEl: visibilityFilterEl,
    pillsEl: pillsContainer,
    subPillsEl,
    visibilityOptions: [
      { value: 'all', label: L.filterAll },
      { value: 'shared', label: L.filterShared },
      { value: 'private', label: L.filterPrivate },
      { value: 'favorites', label: L.filterFavorites },
    ],
    labels: { pillAll: L.pillAll, pillSubAll: L.pillSubAll },
    getItems: () => currentScripts,
    isFavorite: (item) => favoriteIds.has(item.id ?? ''),
    onChange: () => applyFilters(),
  });

  // ── Refresh button ─────────────────────────────────────────────────────────

  refreshBtn.addEventListener('click', () => {
    win.__vscode.postMessage({ type: 'loadYamlScripts' });
    win.__vscode.postMessage({ type: 'loadFavorites' });
  });

  // ── Form inputs management ───────────────────────────────────────────────

  const inputsEditor = createFormInputsEditor({
    listEl: formInputsList,
    addBtn: addInputBtn,
    labels: L,
  });

  // ── New Script form ────────────────────────────────────────────────────────

  function updateContentPlaceholder() {
    const placeholders = {
      apex: L.placeholderApexContent,
      command: L.placeholderCommandContent,
      js: L.placeholderJsContent,
    };
    editor.setPlaceholder(
      placeholders[/** @type {'apex'|'command'|'js'} */ (formType.value)] ??
        L.placeholderApexContent,
    );
  }

  function updateSourceMode() {
    const isFile = formSource.value === 'file';
    const contentRow = document.getElementById('yaml-form-content-row');
    if (contentRow) contentRow.style.display = isFile ? 'none' : '';
    formFileRow.style.display = isFile ? '' : 'none';
  }

  function updateSaveBtn() {
    const isFile = formSource.value === 'file';
    const hasContent = isFile
      ? formFilePath.value.trim() !== ''
      : editor.getContent().trim() !== '';
    formSaveBtn.disabled =
      formName.value.trim() === '' || formFolder.value.trim() === '' || !hasContent;
  }

  function updateApexDefaultsVisibility() {
    if (formApexDefaultsRow) {
      formApexDefaultsRow.style.display = formType.value === 'apex' ? '' : 'none';
    }
    // Reset checkboxes when switching away from apex to avoid stale state
    if (formType.value !== 'apex') {
      if (formFilterUserDebug) formFilterUserDebug.checked = false;
      if (formFormatJson) formFormatJson.checked = false;
    }
  }

  function resetForm() {
    formName.value = '';
    formDescription.value = '';
    formType.value = 'apex';
    formFolder.value = '';
    formSource.value = 'inline';
    formFilePath.value = '';
    editor.setContent('');
    formError.textContent = '';
    inputsEditor.clear();
    updateContentPlaceholder();
    editor.setLanguage(/** @type {'apex' | 'command' | 'js'} */ (formType.value));
    updateSourceMode();
    updateSaveBtn();
    if (formFilterUserDebug) formFilterUserDebug.checked = false;
    if (formFormatJson) formFormatJson.checked = false;
    updateApexDefaultsVisibility();
  }

  const folderCombobox = createFolderCombobox({
    wrapper: /** @type {HTMLElement} */ (formFolder.closest('.yaml-folder-combobox')),
    input: formFolder,
    toggleBtn: folderToggle,
    dropdownEl: folderDropdown,
    optionClass: 'yaml-folder-option',
    getFolders: () => currentScripts.map((s) => s.folder),
    onSelect: () => updateSaveBtn(),
  });

  function showNewForm() {
    editingScriptId = null;
    editingScriptSource = null;
    formDeleteBtn.style.display = 'none';
    formPrivate.checked = false;
    resetForm();
    const filterState = filterBar.getState();
    if (filterState.folder !== 'all') {
      formFolder.value = filterState.subFolder ?? filterState.folder;
      updateSaveBtn();
    }
    folderCombobox.refresh();
    newForm.style.display = '';
    newBtn.disabled = true;
    formName.focus();
  }

  /**
   * @param {{ id: string; folder: string; name: string; description: string; type: 'apex' | 'command' | 'js'; script: string; scriptFile?: string; invalid?: true; source?: 'builtin' | 'user' | 'private'; filterUserDebug?: boolean; formatJson?: boolean; inputs?: Array<{ name: string; label?: string; type?: 'string' | 'picklist' | 'checkbox'; required?: boolean; options?: string[]; default?: boolean }> }} script
   */
  function showEditForm(script) {
    editingScriptId = script.id;
    editingScriptSource = script.source ?? 'user';
    formPrivate.checked = script.source === 'private';
    formName.value = script.name;
    formDescription.value = script.description ?? '';
    formType.value = script.type;
    formFolder.value = script.folder;
    formSource.value = script.scriptFile ? 'file' : 'inline';
    formFilePath.value = script.scriptFile ?? '';
    editor.setContent(script.scriptFile ? '' : (script.script ?? ''));
    editor.setLanguage(script.type);
    formError.textContent = '';
    inputsEditor.setInputs(
      (script.inputs || []).map((/** @type {any} */ inp) => ({
        name: inp.name || '',
        label: inp.label || '',
        type: /** @type {'string' | 'picklist' | 'checkbox' | 'textarea'} */ (
          ['picklist', 'checkbox', 'textarea'].includes(inp.type) ? inp.type : 'string'
        ),
        required: !!inp.required,
        options:
          inp.type === 'picklist' && Array.isArray(inp.options) ? inp.options.join(', ') : '',
        checkboxDefault: inp.type === 'checkbox' ? inp.default === true : false,
      })),
    );
    updateContentPlaceholder();
    updateSourceMode();
    updateSaveBtn();
    if (formFilterUserDebug) formFilterUserDebug.checked = script.filterUserDebug ?? false;
    if (formFormatJson) formFormatJson.checked = script.formatJson ?? false;
    updateApexDefaultsVisibility();
    formDeleteBtn.textContent = L.btnDelete;
    formDeleteBtn.style.display = '';
    folderCombobox.refresh();
    newForm.style.display = '';
    newBtn.disabled = true;
    formName.focus();
  }

  function hideNewForm() {
    newForm.style.display = 'none';
    newBtn.disabled = false;
    editingScriptId = null;
  }

  updateContentPlaceholder();
  updateSourceMode();
  formType.addEventListener('change', () => {
    updateContentPlaceholder();
    editor.setLanguage(/** @type {'apex' | 'command' | 'js'} */ (formType.value));
    updateApexDefaultsVisibility();
  });
  formSource.addEventListener('change', updateSourceMode);
  formSource.addEventListener('change', updateSaveBtn);
  formName.addEventListener('input', updateSaveBtn);
  formFolder.addEventListener('input', updateSaveBtn);
  formContent.addEventListener('input', updateSaveBtn);
  formFilePath.addEventListener('input', updateSaveBtn);
  formBrowseBtn.addEventListener('click', () => {
    win.__vscode.postMessage({ type: 'browseForScriptFile' });
  });
  newBtn.addEventListener('click', showNewForm);
  formCancelBtn.addEventListener('click', () => {
    hideNewForm();
    resetForm();
  });

  formSaveBtn.addEventListener('click', () => {
    const nameVal = formName.value.trim();
    const folderVal = formFolder.value.trim();
    const isFile = formSource.value === 'file';
    const filePathVal = formFilePath.value.trim();
    const contentVal = editor.getContent().trim();
    if (!nameVal) {
      formError.textContent = L.errorNameRequired;
      formName.focus();
      return;
    }
    if (!folderVal) {
      formError.textContent = L.errorFolderRequired;
      formFolder.focus();
      return;
    }
    if (!isFile && !contentVal) {
      formError.textContent = L.errorContentRequired;
      formContent.focus();
      return;
    }
    if (isFile && !filePathVal) {
      formError.textContent = L.errorFilePathRequired;
      formFilePath.focus();
      return;
    }
    // Validate inputs
    const cleanedInputs = inputsEditor
      .getInputs()
      .filter((inp) => inp.name.trim())
      .map((inp) => {
        /** @type {{ name: string; label?: string; type?: 'picklist' | 'checkbox' | 'textarea'; required?: boolean; options?: string[]; default?: boolean }} */
        const entry = { name: inp.name.trim() };
        if (inp.label.trim()) entry.label = inp.label.trim();
        if (inp.type === 'picklist') {
          entry.type = 'picklist';
          entry.options = inp.options
            .split(',')
            .map((/** @type {string} */ o) => o.trim())
            .filter(Boolean);
        } else if (inp.type === 'checkbox') {
          entry.type = 'checkbox';
          if (inp.checkboxDefault) entry.default = true;
        } else if (inp.type === 'textarea') {
          entry.type = 'textarea';
        }
        if (inp.required) entry.required = true;
        return entry;
      });

    const inputNames = new Set();
    for (const inp of cleanedInputs) {
      if (!/^[a-zA-Z_]\w*$/.test(inp.name)) {
        formError.textContent = L.errorInputNameInvalid;
        return;
      }
      if (inputNames.has(inp.name)) {
        formError.textContent = L.errorInputNameDuplicate;
        return;
      }
      if (inp.type === 'picklist' && (!inp.options || inp.options.length === 0)) {
        formError.textContent = L.errorPicklistOptionsRequired;
        return;
      }
      inputNames.add(inp.name);
    }

    formError.textContent = '';
    formSaveBtn.disabled = true;

    const payload = {
      name: nameVal,
      description: formDescription.value.trim(),
      type: formType.value,
      folder: folderVal,
      script: isFile ? '' : contentVal,
      ...(isFile ? { scriptFile: filePathVal } : {}),
      inputs: cleanedInputs,
      ...(formType.value === 'apex' && formFilterUserDebug?.checked
        ? { filterUserDebug: true }
        : {}),
      ...(formType.value === 'apex' && formFormatJson?.checked ? { formatJson: true } : {}),
    };

    const isPrivate = formPrivate.checked;

    if (editingScriptId !== null) {
      win.__vscode.postMessage({
        type: 'updateYamlScript',
        oldScriptId: editingScriptId,
        input: payload,
        isPrivate,
        wasPrivate: editingScriptSource === 'private',
      });
    } else {
      win.__vscode.postMessage({ type: 'saveYamlScript', input: payload, isPrivate });
    }
  });

  formDeleteBtn.addEventListener('click', () => {
    if (!editingScriptId) return;
    win.__vscode.postMessage({
      type: 'deleteYamlScript',
      scriptId: editingScriptId,
      scriptName: formName.value.trim() || editingScriptId,
      isPrivate: editingScriptSource === 'private',
    });
  });

  // ── Filtering ─────────────────────────────────────────────────────────────

  function applyFilters() {
    const accordions = scriptsList.querySelectorAll('.accordion');
    const visible = applyListFilter({
      elements: accordions,
      getAttrs: (el) => ({
        folder: el.getAttribute('data-folder') ?? '',
        source: el.getAttribute('data-source') ?? '',
        id: el.getAttribute('data-script-id') ?? '',
        searchText: el.getAttribute('data-search-text') ?? '',
      }),
      matches: (item) => filterBar.matches(item),
      query: searchInput.value,
    });

    noResults.style.display = visible === 0 && accordions.length > 0 ? 'block' : 'none';
    noResults.textContent = L.noResults;
  }

  searchInput.addEventListener('input', applyFilters);

  // ── Accordion builder ─────────────────────────────────────────────────────

  const accordionBuilder = createAccordionBuilder({
    labels: L,
    scriptsList,
    favoriteIds,
    opIdToScriptId,
    executeStateUpdaters,
    getConnected: () => connected,
    getCurrentOrgData: () => currentOrgData,
    onEditClick: (script) => showEditForm(script),
    vscode: win.__vscode,
    startAction: (btn, onCancel) => win.__startAction(btn, onCancel),
    confirmIfSensitive: (orgData, prompt, onConfirmed, onCancelled) =>
      win.__confirmIfSensitive(orgData, prompt, onConfirmed, onCancelled),
    escapeHtml: win.__escapeHtml,
    renderLogWithLinks,
    renderLogWithJsonTables,
  });
  const buildAccordion = accordionBuilder.buildAccordion;
  const updateFavoriteStars = accordionBuilder.updateFavoriteStars;

  // ── Render scripts list ───────────────────────────────────────────────────

  /**
   * @param {{ id: string; folder: string; name: string; description: string; type: 'apex' | 'command' | 'js'; script: string; scriptFile?: string; source: 'builtin' | 'user' | 'private'; invalid?: true; error?: string; inputs?: Array<{ name: string; label?: string; type?: 'string' | 'picklist' | 'checkbox'; required?: boolean; options?: string[]; default?: boolean }> }[]} scripts
   */
  function renderScripts(scripts) {
    currentScripts = scripts;
    executeStateUpdaters.clear();
    scriptsList.innerHTML = '';
    loadError.textContent = '';

    if (scripts.length === 0) {
      noResults.textContent = L.noScripts;
      noResults.style.display = 'block';
      return;
    }

    noResults.style.display = 'none';

    // Rebuild pills/visibility — reconciles the previous selection against the
    // new script list (restores it when the folders still exist)
    filterBar.render();

    // Populate folder dropdown for the new-script form
    folderCombobox.refresh();

    for (const script of scripts) {
      scriptsList.appendChild(buildAccordion(script));
    }

    applyFilters();

    // After save: scroll new script into view and briefly highlight it
    if (lastSavedScriptId) {
      const savedId = lastSavedScriptId;
      lastSavedScriptId = null;
      scrollAndHighlight(
        scriptsList,
        `[data-script-id="${CSS.escape(savedId)}"]`,
        'yaml-script--highlight',
      );
    }
  }

  // ── Update execute button states ──────────────────────────────────────────

  function updateExecuteBtns() {
    scriptsList.querySelectorAll('.accordion').forEach((accordion) => {
      const scriptId = accordion.getAttribute('data-script-id');
      const updater = scriptId && executeStateUpdaters.get(scriptId);
      if (updater) {
        updater();
        return;
      }
      // Fallback for scripts without inputs
      const scriptType = accordion.getAttribute('data-script-type');
      if (scriptType === 'command' || scriptType === 'js') return;
      const btn = /** @type {HTMLButtonElement | null} */ (
        accordion.querySelector('.yaml-execute-btn')
      );
      if (btn) btn.disabled = !connected;
    });
  }

  // ── Handle result for a specific script ───────────────────────────────────

  /**
   * @param {{ scriptId: string; success: boolean; message: string; debugLog: string; filteredDebugLog?: string; opId?: string; cancelled?: boolean }} data
   */
  function handleExecuteResult(data) {
    const accordion = /** @type {HTMLElement | null} */ (
      scriptsList.querySelector(`[data-script-id="${CSS.escape(data.scriptId)}"]`)
    );
    if (!accordion) return;

    const statusHint = /** @type {HTMLElement} */ (accordion.querySelector('.yaml-status'));
    const errorBox = /** @type {HTMLElement} */ (accordion.querySelector('.error-box'));
    const logViewer = /** @type {HTMLElement} */ (accordion.querySelector('.yaml-log-viewer'));
    const logOutput = /** @type {HTMLElement} */ (accordion.querySelector('.yaml-log-output'));
    const filterCheckbox = /** @type {HTMLInputElement | null} */ (
      accordion.querySelector('.yaml-log-filter-checkbox')
    );
    const jsonCheckbox = /** @type {HTMLInputElement | null} */ (
      accordion.querySelector('.yaml-log-json-checkbox')
    );

    // __endAction re-enables the button; then re-evaluate state (e.g. org may have disconnected)
    if (data.opId) {
      opIdToScriptId.delete(data.opId);
      scriptLogContent.delete(data.opId);
    }
    win.__endAction(data.opId);
    const updater = executeStateUpdaters.get(data.scriptId);
    if (updater) updater();

    if (data.cancelled) {
      statusHint.textContent = L.statusCancelled;
      return;
    }

    statusHint.textContent = '';

    if (!data.success) {
      errorBox.textContent = data.message;
    } else {
      errorBox.textContent = '';
    }

    const openInEditorBtn = /** @type {HTMLElement} */ (
      accordion.querySelector('.yaml-open-editor-btn')
    );
    const copyToClipboardBtn = /** @type {HTMLElement} */ (
      accordion.querySelector('.yaml-copy-output-btn')
    );
    if (data.debugLog) {
      logOutput.setAttribute('data-raw-log', data.debugLog);
      if (data.filteredDebugLog) {
        logOutput.setAttribute('data-filtered-log', data.filteredDebugLog);
      }
      const logText =
        filterCheckbox?.checked && data.filteredDebugLog ? data.filteredDebugLog : data.debugLog;
      logOutput.innerHTML = jsonCheckbox?.checked
        ? renderLogWithJsonTables(logText)
        : renderLogWithLinks(logText);
      logOutput.classList.add(data.success ? 'yaml-log-output--success' : 'yaml-log-output--error');
      logViewer.style.display = 'block';
      openInEditorBtn.style.display = '';
      copyToClipboardBtn.style.display = '';
    } else {
      openInEditorBtn.style.display = 'none';
      copyToClipboardBtn.style.display = 'none';
      logViewer.style.display = 'none';
    }
  }

  // ── Message handlers ─────────────────────────────────────────────────────

  /** @param {{ opId: string; chunk: string }} data */
  function handleScriptLogChunk(data) {
    const { opId, chunk } = data;
    const scriptId = opIdToScriptId.get(opId);
    if (!scriptId) return;
    const accordion = /** @type {HTMLElement | null} */ (
      scriptsList.querySelector(`[data-script-id="${CSS.escape(scriptId)}"]`)
    );
    if (!accordion) return;
    const viewer = /** @type {HTMLElement | null} */ (accordion.querySelector('.yaml-log-viewer'));
    const output = /** @type {HTMLElement | null} */ (accordion.querySelector('.yaml-log-output'));
    if (!viewer || !output) return;
    viewer.style.display = 'block';
    // Store log text in memory (not DOM) to avoid O(n²) string copying
    const next = (scriptLogContent.get(opId) || '') + chunk;
    scriptLogContent.set(opId, next);
    output.textContent = next;
  }

  /** @param {any} data */
  function handleSaveResult(data) {
    const savedScript = data?.script;
    lastSavedScriptId = savedScript?.id ?? null;
    hideNewForm();
    if (savedScript?.folder) {
      const top = savedScript.folder.split('/')[0];
      filterBar.setState({
        folder: top,
        subFolder: savedScript.folder !== top ? savedScript.folder : null,
      });
    }
    const after = savedScript
      ? [...currentScripts.filter((s) => s.id !== savedScript.id), savedScript].sort((a, b) =>
          a.name.localeCompare(b.name),
        )
      : currentScripts;
    renderScripts(after);
    win.__vscode.postMessage({ type: 'loadYamlScripts' });
  }

  /** @param {any} data */
  function handleUpdateResult(data) {
    const updatedScript = data?.script;
    const oldScriptId = data?.oldScriptId;
    lastSavedScriptId = updatedScript?.id ?? null;
    hideNewForm();
    if (updatedScript?.folder) {
      const top = updatedScript.folder.split('/')[0];
      filterBar.setState({
        folder: top,
        subFolder: updatedScript.folder !== top ? updatedScript.folder : null,
      });
    }
    const after = updatedScript
      ? [
          ...currentScripts.filter((s) => s.id !== oldScriptId && s.id !== updatedScript.id),
          updatedScript,
        ].sort((a, b) => a.name.localeCompare(b.name))
      : currentScripts;
    renderScripts(after);
    win.__vscode.postMessage({ type: 'loadYamlScripts' });
  }

  /** @param {any} data */
  function handleDeleteResult(data) {
    if (!data?.deleted) return;
    const deletedId = data.scriptId;
    const el = scriptsList.querySelector(`[data-script-id="${CSS.escape(deletedId)}"]`);
    el?.remove();
    executeStateUpdaters.delete(deletedId);
    currentScripts = currentScripts.filter((s) => s.id !== deletedId);
    hideNewForm();
    if (currentScripts.length === 0) {
      noResults.textContent = L.noScripts;
      noResults.style.display = 'block';
    } else {
      applyFilters();
    }
  }

  /** @param {any} data */
  function handleFavorites(data) {
    favoriteIds.clear();
    for (const id of data?.favorites ?? []) favoriteIds.add(id);
    updateFavoriteStars();
    applyFilters();
  }

  /** @type {Record<string, (data: any) => void>} */
  const messageHandlers = {
    loadYamlScriptsResult: (data) => renderScripts(data.scripts ?? []),
    loadYamlScriptsError: (data) => {
      loadError.textContent = data?.message ?? 'Failed to load scripts.';
    },
    executeYamlScriptResult: (data) => handleExecuteResult(data),
    scriptLogChunk: handleScriptLogChunk,
    executeYamlScriptError: (data) => win.__endAction(data?.opId),
    saveYamlScriptResult: handleSaveResult,
    saveYamlScriptError: (data) => {
      formSaveBtn.disabled = false;
      formError.textContent = data?.message ?? 'Failed to save script.';
    },
    updateYamlScriptResult: handleUpdateResult,
    updateYamlScriptError: (data) => {
      formSaveBtn.disabled = false;
      formError.textContent = data?.message ?? 'Failed to update script.';
    },
    deleteYamlScriptResult: handleDeleteResult,
    deleteYamlScriptError: (data) => {
      formError.textContent = data?.message ?? 'Failed to delete script.';
    },
    loadFavoritesResult: handleFavorites,
    toggleFavoriteResult: handleFavorites,
    browseForScriptFileResult: (data) => {
      if (!data?.cancelled) {
        formFilePath.value = data?.filePath ?? '';
        updateSaveBtn();
      }
    },
  };

  // ── Feature registration ──────────────────────────────────────────────────

  win.__registerFeature('yaml-scripts', {
    onOrgConnected: (/** @type {any} */ orgData) => {
      connected = true;
      currentOrgData = orgData;
      updateExecuteBtns();
      const orgId = orgData && (orgData.orgId || orgData.username);
      const sameOrg = orgId && orgId === lastConnectedOrgId;
      lastConnectedOrgId = orgId || null;
      if (!sameOrg || currentScripts.length === 0) {
        win.__vscode.postMessage({ type: 'loadYamlScripts' });
        win.__vscode.postMessage({ type: 'loadFavorites' });
      }
    },
    onOrgDisconnected: () => {
      connected = false;
      currentOrgData = null;
      updateExecuteBtns();
    },
    /** @param {{ type: string; data: any }} message */
    onMessage: (message) => {
      const handler = messageHandlers[message.type];
      if (handler) handler(message.data);
    },
  });
})();

// @ts-check
// New/Edit script form controller: owns the form DOM refs, label init, the
// code editor + inputs editor instances, the folder combobox, show/hide
// logic, validation and save/update/delete dispatch. Receives a `ctx` object
// so it never reaches into the orchestrator's module scope directly.
import { createCodeEditor } from './code-editor.js';
import { createFormInputsEditor } from './form-inputs-editor.js';
import { createFolderCombobox } from '../../../shared/view/folder-combobox.js';

/**
 * @typedef {Object} ScriptFormCtx
 * @property {any} labels
 * @property {{ postMessage: (msg: any) => void }} vscode
 * @property {any} hljs
 * @property {{ getState: () => { visibility: string; folder: string; subFolder: string | null } }} filterBar
 * @property {() => { folder: string }[]} getCurrentScripts
 */

/**
 * @param {ScriptFormCtx} ctx
 */
export function createScriptForm(ctx) {
  const { labels: L, vscode, hljs, filterBar, getCurrentScripts } = ctx;

  // ── DOM refs ──────────────────────────────────────────────────────────────
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
    hljs,
  });

  /** @type {string | null} */
  let editingScriptId = null;
  /** @type {string | null} */
  let editingScriptSource = null;

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

  // ── Form inputs management ───────────────────────────────────────────────

  const inputsEditor = createFormInputsEditor({
    listEl: formInputsList,
    addBtn: addInputBtn,
    labels: L,
  });

  // ── Form state helpers ─────────────────────────────────────────────────────

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
    getFolders: () => getCurrentScripts().map((s) => s.folder),
    onSelect: () => updateSaveBtn(),
  });

  // ── Show/hide ──────────────────────────────────────────────────────────────

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

  // ── Wiring ─────────────────────────────────────────────────────────────────

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
    vscode.postMessage({ type: 'browseForScriptFile' });
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
      vscode.postMessage({
        type: 'updateYamlScript',
        oldScriptId: editingScriptId,
        input: payload,
        isPrivate,
        wasPrivate: editingScriptSource === 'private',
      });
    } else {
      vscode.postMessage({ type: 'saveYamlScript', input: payload, isPrivate });
    }
  });

  formDeleteBtn.addEventListener('click', () => {
    if (!editingScriptId) return;
    vscode.postMessage({
      type: 'deleteYamlScript',
      scriptId: editingScriptId,
      scriptName: formName.value.trim() || editingScriptId,
      isPrivate: editingScriptSource === 'private',
    });
  });

  // ── Public API (message-result hooks invoked from index.js) ──────────────

  return {
    showNewForm,
    showEditForm,
    hideNewForm,
    refreshFolders: () => folderCombobox.refresh(),
    /** @param {string} message */
    onSaveError(message) {
      formSaveBtn.disabled = false;
      formError.textContent = message;
    },
    /** @param {string} message */
    onDeleteError(message) {
      formError.textContent = message;
    },
    /** @param {string} filePath */
    setFilePath(filePath) {
      formFilePath.value = filePath;
      updateSaveBtn();
    },
  };
}

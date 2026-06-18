// @ts-check
// New/Edit script form controller: owns the form DOM refs, label init, the
// code editor + inputs editor instances, the folder combobox, show/hide
// logic, validation and save/update/delete dispatch. Receives a `ctx` object
// so it never reaches into the orchestrator's module scope directly.
import { createCodeEditor } from './code-editor.js';
import { createFormInputsEditor } from './form-inputs-editor.js';
import { createFolderCombobox } from '../../../shared/view/folder-combobox.js';
import { collectFormRefs, initFormLabels } from './script-form-dom.js';
import { createAiFields } from './script-form-ai.js';
import { cleanInputs, validateInputs, buildScriptPayload } from './script-form-payload';

/**
 * @typedef {Object} ScriptFormCtx
 * @property {any} labels
 * @property {{ postMessage: (msg: any) => void }} vscode
 * @property {{ getState: () => { visibility: string; folder: string; subFolder: string | null } }} filterBar
 * @property {() => { folder: string }[]} getCurrentScripts
 */

/**
 * @param {ScriptFormCtx} ctx
 */
export function createScriptForm(ctx) {
  const { labels: L, vscode, filterBar, getCurrentScripts } = ctx;

  // ── DOM refs ──────────────────────────────────────────────────────────────
  const refs = collectFormRefs();
  const {
    newBtn,
    newForm,
    formName,
    formDescription,
    formType,
    formFolder,
    folderToggle,
    folderDropdown,
    formContent,
    formEditInEditorBtn,
    formSource,
    formFileRow,
    formFilePath,
    formBrowseBtn,
    formPrivate,
    formError,
    formSaveBtn,
    formCancelBtn,
    formDeleteBtn,
    formCloneBtn,
    formApexDefaultsRow,
    formFilterUserDebug,
    formFormatJson,
    formInputsList,
    addInputBtn,
    formModel,
    formGatherEnabled,
  } = refs;

  // Hide form immediately via JS — the CSP blocks inline style="display:none" attributes
  newForm.style.display = 'none';
  formDeleteBtn.style.display = 'none';
  formCloneBtn.style.display = 'none';
  formFileRow.style.display = 'none';

  initFormLabels(refs, L);

  // ── Plain-textarea code editor ──────────────────────────────────────────
  const editor = createCodeEditor({ textarea: formContent });

  /** @type {string | null} */
  let editingScriptId = null;
  /** @type {string | null} */
  let editingScriptSource = null;

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
      ai: L.placeholderAiContent,
    };
    editor.setPlaceholder(
      placeholders[/** @type {'apex'|'command'|'js'|'ai'} */ (formType.value)] ??
        L.placeholderApexContent,
    );
    const contentLabelEl = document.getElementById('yaml-form-content-label');
    if (contentLabelEl) {
      contentLabelEl.textContent = formType.value === 'ai' ? L.labelAiPrompt : L.labelContent;
    }
  }

  function updateSourceMode() {
    const isFile = formSource.value === 'file';
    const contentRow = document.getElementById('yaml-form-content-row');
    if (contentRow) contentRow.style.display = isFile ? 'none' : '';
    formFileRow.style.display = isFile ? '' : 'none';
    // The "Open in editor" button edits the inline textarea — irrelevant for
    // file-based scripts (the referenced file is opened via the subtitle link).
    formEditInEditorBtn.style.display = isFile ? 'none' : '';
  }

  function updateSaveBtn() {
    const isFile = formSource.value === 'file';
    const hasContent = isFile
      ? formFilePath.value.trim() !== ''
      : editor.getContent().trim() !== '';
    // Gather is optional; it's only required to be filled when its box is checked.
    const gatherOk =
      formType.value !== 'ai' || !formGatherEnabled.checked || aiFields.gatherFilled();
    // AI scripts require an explicit model choice.
    const modelOk = formType.value !== 'ai' || formModel.value !== '';
    formSaveBtn.disabled =
      formName.value.trim() === '' ||
      formFolder.value.trim() === '' ||
      !hasContent ||
      !gatherOk ||
      !modelOk;
  }

  // ── AI sub-controller (model/skills picker, gather step) ───────────────────
  const aiFields = createAiFields({
    refs: {
      formModel,
      formModelHint: refs.formModelHint,
      formGatherEnabled,
      formGatherBody: refs.formGatherBody,
      formGatherType: refs.formGatherType,
      formGatherContent: refs.formGatherContent,
      formGatherFileRow: refs.formGatherFileRow,
      formGatherFilePath: refs.formGatherFilePath,
      formGatherBrowseBtn: refs.formGatherBrowseBtn,
      formAllowFollowup: refs.formAllowFollowup,
      formAllowReadFiles: refs.formAllowReadFiles,
      formSkills: refs.formSkills,
      formSkillsHint: refs.formSkillsHint,
    },
    labels: L,
    vscode,
    updateSaveBtn,
  });

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
    aiFields.reset();
    updateContentPlaceholder();
    updateSourceMode();
    updateSaveBtn();
    if (formFilterUserDebug) formFilterUserDebug.checked = false;
    if (formFormatJson) formFormatJson.checked = false;
    updateApexDefaultsVisibility();
    aiFields.updateAiVisibility(formType.value === 'ai');
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

  /** Drop any inline height left over from a previous drag-resize. */
  function resetCodeHeight() {
    formContent.style.height = '';
  }

  function showNewForm() {
    editingScriptId = null;
    editingScriptSource = null;
    resetCodeHeight();
    formDeleteBtn.style.display = 'none';
    formCloneBtn.style.display = 'none';
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
   * @param {{ id: string; folder: string; name: string; description: string; type: 'apex' | 'command' | 'js' | 'ai'; script: string; scriptFile?: string; invalid?: true; source?: 'builtin' | 'user' | 'private'; filterUserDebug?: boolean; formatJson?: boolean; model?: string; gather?: { kind: 'apex' | 'apex-file' | 'soql'; value: string; file?: string }; allowFollowupQueries?: boolean; allowReadWorkspaceFiles?: boolean; skills?: string[]; inputs?: Array<{ name: string; label?: string; type?: 'string' | 'picklist' | 'checkbox'; required?: boolean; options?: string[]; default?: boolean }> }} script
   */
  function showEditForm(script) {
    editingScriptId = script.id;
    editingScriptSource = script.source ?? 'user';
    resetCodeHeight();
    formPrivate.checked = script.source === 'private';
    formName.value = script.name;
    formDescription.value = script.description ?? '';
    formType.value = script.type;
    formFolder.value = script.folder;
    formSource.value = script.scriptFile ? 'file' : 'inline';
    formFilePath.value = script.scriptFile ?? '';
    editor.setContent(script.scriptFile ? '' : (script.script ?? ''));
    aiFields.populateFromScript(script);
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
    aiFields.updateAiVisibility(formType.value === 'ai');
    if (formType.value === 'ai') aiFields.requestLists();
    formDeleteBtn.textContent = L.btnDelete;
    formDeleteBtn.style.display = '';
    formCloneBtn.style.display = '';
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
  aiFields.updateAiVisibility(formType.value === 'ai');
  formType.addEventListener('change', () => {
    updateContentPlaceholder();
    updateApexDefaultsVisibility();
    aiFields.updateAiVisibility(formType.value === 'ai');
    updateSaveBtn();
    if (formType.value === 'ai') aiFields.requestLists();
  });
  formSource.addEventListener('change', updateSourceMode);
  formSource.addEventListener('change', updateSaveBtn);
  formName.addEventListener('input', updateSaveBtn);
  formFolder.addEventListener('input', updateSaveBtn);
  formContent.addEventListener('input', updateSaveBtn);
  formFilePath.addEventListener('input', updateSaveBtn);
  formBrowseBtn.addEventListener('click', () => {
    aiFields.markPromptBrowseTarget();
    vscode.postMessage({ type: 'browseForScriptFile' });
  });
  // Open the current code body in a native VS Code editor. The editor edits only
  // the code string; on save the host pushes `scriptCodeUpdated` back into the
  // textarea (see setCodeFromEditor). Persistence stays on the form's Save button.
  formEditInEditorBtn.addEventListener('click', () => {
    vscode.postMessage({
      type: 'editScriptCode',
      code: editor.getContent(),
      scriptType: formType.value,
      name: formName.value.trim(),
    });
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
    if (formType.value === 'ai' && !formModel.value) {
      formError.textContent = L.errorModelRequired;
      formModel.focus();
      return;
    }
    if (formType.value === 'ai' && formGatherEnabled.checked && !aiFields.gatherFilled()) {
      formError.textContent = L.errorGatherRequired;
      (refs.formGatherType.value === 'apex-file'
        ? refs.formGatherFilePath
        : refs.formGatherContent
      ).focus();
      return;
    }

    const cleanedInputs = cleanInputs(inputsEditor.getInputs());
    const inputError = validateInputs(cleanedInputs);
    if (inputError) {
      formError.textContent = L[inputError];
      return;
    }

    formError.textContent = '';
    formSaveBtn.disabled = true;

    const payload = buildScriptPayload({
      name: nameVal,
      description: formDescription.value.trim(),
      type: /** @type {'apex'|'command'|'js'|'ai'} */ (formType.value),
      folder: folderVal,
      isFile,
      filePath: filePathVal,
      content: contentVal,
      inputs: cleanedInputs,
      filterUserDebug: !!formFilterUserDebug?.checked,
      formatJson: !!formFormatJson?.checked,
      ...(formType.value === 'ai' ? { aiFields: aiFields.buildAiFields() } : {}),
    });

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

  // Clone: turn the open edit form into a pre-filled *new* form. Every field
  // value carries over untouched; only the name gets a `_copy` suffix and the
  // editing identity is cleared so the next Save creates a new file (nothing is
  // written to disk until then).
  function convertToClone() {
    editingScriptId = null;
    editingScriptSource = null;
    formName.value = (formName.value.trim() || 'script') + L.cloneSuffix;
    formDeleteBtn.style.display = 'none';
    formCloneBtn.style.display = 'none';
    formError.textContent = '';
    updateSaveBtn();
    formName.focus();
    formName.select();
  }
  formCloneBtn.addEventListener('click', convertToClone);

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
    /**
     * Sync code edited in the native VS Code editor back into the textarea.
     * @param {string} code
     */
    setCodeFromEditor(code) {
      editor.setContent(code ?? '');
      updateSaveBtn();
    },
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
      if (!aiFields.applyBrowsedFilePath(filePath)) {
        formFilePath.value = filePath;
        updateSaveBtn();
      }
    },
    /** @param {Array<{ id: string; name?: string; family?: string }>} models */
    setModels(models) {
      aiFields.setModels(models);
    },
    /** @param {Array<{ id: string; name?: string; description?: string }>} skills */
    setSkills(skills) {
      aiFields.setSkills(skills);
    },
  };
}

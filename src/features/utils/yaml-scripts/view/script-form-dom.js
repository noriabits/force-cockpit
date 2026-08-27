// @ts-check
// DOM-ref collection and static label binding for the new/edit script form.
// Pure glue: no state, no event wiring — script-form.js owns behaviour.

/**
 * @returns {{
 *   newBtn: HTMLButtonElement, newForm: HTMLElement, formName: HTMLInputElement,
 *   formDescription: HTMLTextAreaElement, formType: HTMLSelectElement,
 *   formFolder: HTMLInputElement, folderToggle: HTMLButtonElement, folderDropdown: HTMLElement,
 *   formContent: HTMLTextAreaElement, formEditInEditorBtn: HTMLButtonElement,
 *   formSource: HTMLSelectElement, formFileRow: HTMLElement, formFilePath: HTMLInputElement,
 *   formBrowseBtn: HTMLButtonElement, formPrivate: HTMLInputElement, formPrivateLabel: HTMLElement,
 *   formError: HTMLElement, formSaveBtn: HTMLButtonElement, formCancelBtn: HTMLButtonElement,
 *   formDeleteBtn: HTMLButtonElement, formCloneBtn: HTMLButtonElement,
 *   formApexDefaultsRow: HTMLElement, formFilterUserDebug: HTMLInputElement, formFormatJson: HTMLInputElement,
 *   formInputsList: HTMLElement, addInputBtn: HTMLButtonElement, formInputsLabel: HTMLElement,
 *   formModel: HTMLSelectElement, formModelHint: HTMLElement,
 *   formGatherEnabled: HTMLInputElement, formGatherBody: HTMLElement, formGatherType: HTMLSelectElement,
 *   formGatherContent: HTMLTextAreaElement, formGatherFileRow: HTMLElement,
 *   formGatherFilePath: HTMLInputElement, formGatherBrowseBtn: HTMLButtonElement,
 *   formAllowFollowup: HTMLInputElement, formAllowReadFiles: HTMLInputElement,
 *   formSkills: HTMLElement, formSkillsHint: HTMLElement,
 *   formRestMethod: HTMLSelectElement, formRestEndpoint: HTMLInputElement,
 *   formRestHeadersList: HTMLElement, formRestAddHeaderBtn: HTMLButtonElement,
 * }}
 */
export function collectFormRefs() {
  return {
    newBtn: /** @type {HTMLButtonElement} */ (document.getElementById('yaml-new-btn')),
    newForm: /** @type {HTMLElement} */ (document.getElementById('yaml-new-form')),
    formName: /** @type {HTMLInputElement} */ (document.getElementById('yaml-form-name')),
    formDescription: /** @type {HTMLTextAreaElement} */ (
      document.getElementById('yaml-form-description')
    ),
    formType: /** @type {HTMLSelectElement} */ (document.getElementById('yaml-form-type')),
    formFolder: /** @type {HTMLInputElement} */ (document.getElementById('yaml-form-folder')),
    folderToggle: /** @type {HTMLButtonElement} */ (document.getElementById('yaml-folder-toggle')),
    folderDropdown: /** @type {HTMLElement} */ (document.getElementById('yaml-folder-dropdown')),
    formContent: /** @type {HTMLTextAreaElement} */ (document.getElementById('yaml-form-content')),
    formEditInEditorBtn: /** @type {HTMLButtonElement} */ (
      document.getElementById('yaml-form-edit-in-editor-btn')
    ),
    formSource: /** @type {HTMLSelectElement} */ (document.getElementById('yaml-form-source')),
    formFileRow: /** @type {HTMLElement} */ (document.getElementById('yaml-form-file-row')),
    formFilePath: /** @type {HTMLInputElement} */ (document.getElementById('yaml-form-file-path')),
    formBrowseBtn: /** @type {HTMLButtonElement} */ (
      document.getElementById('yaml-form-browse-btn')
    ),
    formPrivate: /** @type {HTMLInputElement} */ (document.getElementById('yaml-form-private')),
    formPrivateLabel: /** @type {HTMLElement} */ (
      document.getElementById('yaml-form-private-label')
    ),
    formError: /** @type {HTMLElement} */ (document.getElementById('yaml-form-error')),
    formSaveBtn: /** @type {HTMLButtonElement} */ (document.getElementById('yaml-form-save-btn')),
    formCancelBtn: /** @type {HTMLButtonElement} */ (
      document.getElementById('yaml-form-cancel-btn')
    ),
    formDeleteBtn: /** @type {HTMLButtonElement} */ (
      document.getElementById('yaml-form-delete-btn')
    ),
    formCloneBtn: /** @type {HTMLButtonElement} */ (document.getElementById('yaml-form-clone-btn')),

    formApexDefaultsRow: /** @type {HTMLElement} */ (
      document.getElementById('yaml-form-apex-defaults-row')
    ),
    formFilterUserDebug: /** @type {HTMLInputElement} */ (
      document.getElementById('yaml-form-filter-user-debug')
    ),
    formFormatJson: /** @type {HTMLInputElement} */ (
      document.getElementById('yaml-form-format-json')
    ),

    formInputsList: /** @type {HTMLElement} */ (document.getElementById('yaml-form-inputs-list')),
    addInputBtn: /** @type {HTMLButtonElement} */ (document.getElementById('yaml-add-input-btn')),
    formInputsLabel: /** @type {HTMLElement} */ (document.getElementById('yaml-form-inputs-label')),

    formModel: /** @type {HTMLSelectElement} */ (document.getElementById('yaml-form-model')),
    formModelHint: /** @type {HTMLElement} */ (document.getElementById('yaml-form-model-hint')),
    formGatherEnabled: /** @type {HTMLInputElement} */ (
      document.getElementById('yaml-form-gather-enabled')
    ),
    formGatherBody: /** @type {HTMLElement} */ (document.getElementById('yaml-form-gather-body')),
    formGatherType: /** @type {HTMLSelectElement} */ (
      document.getElementById('yaml-form-gather-type')
    ),
    formGatherContent: /** @type {HTMLTextAreaElement} */ (
      document.getElementById('yaml-form-gather-content')
    ),
    formGatherFileRow: /** @type {HTMLElement} */ (
      document.getElementById('yaml-form-gather-file-row')
    ),
    formGatherFilePath: /** @type {HTMLInputElement} */ (
      document.getElementById('yaml-form-gather-file-path')
    ),
    formGatherBrowseBtn: /** @type {HTMLButtonElement} */ (
      document.getElementById('yaml-form-gather-browse-btn')
    ),
    formAllowFollowup: /** @type {HTMLInputElement} */ (
      document.getElementById('yaml-form-allow-followup')
    ),
    formAllowReadFiles: /** @type {HTMLInputElement} */ (
      document.getElementById('yaml-form-allow-read-files')
    ),
    formSkills: /** @type {HTMLElement} */ (document.getElementById('yaml-form-skills')),
    formSkillsHint: /** @type {HTMLElement} */ (document.getElementById('yaml-form-skills-hint')),
    formRestMethod: /** @type {HTMLSelectElement} */ (
      document.getElementById('yaml-form-rest-method')
    ),
    formRestEndpoint: /** @type {HTMLInputElement} */ (
      document.getElementById('yaml-form-rest-endpoint')
    ),
    formRestHeadersList: /** @type {HTMLElement} */ (
      document.getElementById('yaml-form-rest-headers-list')
    ),
    formRestAddHeaderBtn: /** @type {HTMLButtonElement} */ (
      document.getElementById('yaml-form-rest-add-header-btn')
    ),
  };
}

/**
 * Labels a <select>'s options by their `value`, leaving any option the map does
 * not mention untouched.
 * @param {HTMLSelectElement} select
 * @param {Record<string, string>} byValue
 */
function setOptionLabels(select, byValue) {
  for (const option of Array.from(select.options)) {
    const text = byValue[option.value];
    if (text !== undefined) option.text = text;
  }
}

/**
 * Binds all static text/placeholders from the labels object onto the form DOM.
 * @param {ReturnType<typeof collectFormRefs>} refs
 * @param {any} L
 */
export function initFormLabels(refs, L) {
  refs.newBtn.textContent = L.btnNewScript;
  refs.formSaveBtn.textContent = L.btnSave;
  refs.formCancelBtn.textContent = L.btnCancel;
  refs.formCloneBtn.textContent = L.btnClone;
  // Keyed by value, not by index: positional binding silently mislabels every
  // option if one is ever inserted out of order, and the markup has already
  // grown a fifth type.
  setOptionLabels(refs.formType, {
    apex: L.typeApex,
    command: L.typeCommand,
    js: L.typeJs,
    ai: L.typeAi,
    rest: L.typeRest,
  });
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
  refs.formEditInEditorBtn.textContent = L.btnEditInEditor;
  refs.formName.placeholder = L.placeholderName;
  refs.formDescription.placeholder = L.placeholderDescription;
  refs.formFolder.placeholder = L.placeholderFolder;
  if (refs.formInputsLabel) refs.formInputsLabel.textContent = L.labelInputs;
  refs.addInputBtn.textContent = L.btnAddInput;
  setOptionLabels(refs.formSource, { inline: L.sourceInline, file: L.sourceFile });
  const labelSource = document.querySelector('label[for="yaml-form-source"]');
  if (labelSource) labelSource.textContent = L.labelSource;
  const labelFilePath = document.querySelector('label[for="yaml-form-file-path"]');
  if (labelFilePath) labelFilePath.textContent = L.labelFilePath;
  refs.formFilePath.placeholder = L.placeholderFilePath;
  refs.formBrowseBtn.textContent = L.btnBrowse;
  const labelRestMethod = document.querySelector('label[for="yaml-form-rest-method"]');
  const labelRestEndpoint = document.getElementById('yaml-form-rest-endpoint-label');
  const labelRestHeaders = document.getElementById('yaml-form-rest-headers-label');
  if (labelRestMethod) labelRestMethod.textContent = L.labelRestMethod;
  if (labelRestEndpoint) labelRestEndpoint.textContent = L.labelRestEndpoint;
  if (labelRestHeaders) labelRestHeaders.textContent = L.labelRestHeaders;
  refs.formRestEndpoint.placeholder = L.placeholderRestEndpoint;
  refs.formRestAddHeaderBtn.textContent = L.btnAddHeader;

  if (refs.formPrivateLabel) refs.formPrivateLabel.textContent = L.labelPrivate;
  const apexDefaultsLabel = document.getElementById('yaml-form-apex-defaults-label');
  const filterUserDebugLabel = document.getElementById('yaml-form-filter-user-debug-label');
  const formatJsonLabel = document.getElementById('yaml-form-format-json-label');
  if (apexDefaultsLabel) apexDefaultsLabel.textContent = L.labelDefaultOutputSettings;
  if (filterUserDebugLabel) filterUserDebugLabel.textContent = L.labelDefaultFilterUserDebug;
  if (formatJsonLabel) formatJsonLabel.textContent = L.labelDefaultFormatJson;

  const modelLabel = document.getElementById('yaml-form-model-label');
  if (modelLabel) modelLabel.textContent = L.labelModel;
  refs.formModel.options[0].text = L.modelPlaceholder;
  const gatherLabel = document.getElementById('yaml-form-gather-label');
  if (gatherLabel) gatherLabel.textContent = L.labelGather;
  refs.formGatherType.options[0].text = L.gatherTypeSoql;
  refs.formGatherType.options[1].text = L.gatherTypeApex;
  refs.formGatherType.options[2].text = L.gatherTypeApexFile;
  refs.formGatherFilePath.placeholder = L.placeholderFilePath;
  refs.formGatherBrowseBtn.textContent = L.btnBrowse;
  const followupLabel = document.getElementById('yaml-form-followup-label');
  if (followupLabel) followupLabel.textContent = L.labelAllowFollowup;
  const readFilesLabel = document.getElementById('yaml-form-read-files-label');
  if (readFilesLabel) readFilesLabel.textContent = L.labelAllowReadFiles;
  const skillsLabel = document.getElementById('yaml-form-skills-label');
  if (skillsLabel) skillsLabel.textContent = L.labelSkills;
}

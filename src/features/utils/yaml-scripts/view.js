// @ts-check
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

  /** @type {{ name: string; label: string; type: 'string' | 'picklist' | 'checkbox'; required: boolean; options: string; checkboxDefault: boolean }[]} */
  let formInputs = [];

  let connected = false;
  /** @type {any} */
  let currentOrgData = null;
  /** @type {string | null} */
  let lastConnectedOrgId = null;
  let activeFolderFilter = 'all';
  /** @type {string | null} */
  let activeSubFolder = null;
  /** @type {'all' | 'shared' | 'private'} */
  let activeVisibility = 'all';
  /** @type {string | null} */
  let lastSavedScriptId = null;
  /** @type {string | null} */
  let editingScriptId = null;
  /** @type {string | null} */
  let editingScriptSource = null;
  /** @type {{ id: string; folder: string; name: string; description: string; type: 'apex' | 'command' | 'js'; script: string; scriptFile?: string; source: string; invalid?: true; error?: string; inputs?: Array<{ name: string; label?: string; type?: 'string' | 'picklist' | 'checkbox'; required?: boolean; options?: string[]; default?: boolean }> }[]} */
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
  const labelContent = document.querySelector('label[for="yaml-form-content"]');
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

  // ── Visibility filter ──────────────────────────────────────────────────────

  function buildVisibilityFilter() {
    visibilityFilterEl.innerHTML = '';
    const options = /** @type {Array<{value: 'all'|'shared'|'private', label: string}>} */ ([
      { value: 'all', label: L.filterAll },
      { value: 'shared', label: L.filterShared },
      { value: 'private', label: L.filterPrivate },
    ]);
    for (const opt of options) {
      const btn = document.createElement('button');
      btn.className = 'visibility-filter-btn' + (activeVisibility === opt.value ? ' active' : '');
      btn.textContent = opt.label;
      btn.addEventListener('click', () => {
        if (activeVisibility === opt.value) return;
        activeVisibility = opt.value;
        visibilityFilterEl.querySelectorAll('.visibility-filter-btn').forEach((b) => {
          b.classList.toggle('active', b === btn);
        });
        // Reset folder/sub-folder when visibility changes
        activeFolderFilter = 'all';
        activeSubFolder = null;
        rebuildPillsForCurrentVisibility();
        applyFilters();
      });
      visibilityFilterEl.appendChild(btn);
    }
  }

  function rebuildPillsForCurrentVisibility() {
    const visibleScripts = getVisibleScripts(currentScripts);
    const folders = [...new Set(visibleScripts.map((s) => s.folder))].sort();
    buildPills(folders);
  }

  /** @param {any[]} scripts */
  function getVisibleScripts(scripts) {
    if (activeVisibility === 'all') return scripts;
    return scripts.filter((s) =>
      activeVisibility === 'private'
        ? s.source === 'private'
        : s.source === 'user' || s.source === 'builtin',
    );
  }

  // ── Refresh button ─────────────────────────────────────────────────────────

  refreshBtn.addEventListener('click', () => {
    win.__vscode.postMessage({ type: 'loadYamlScripts' });
  });

  // ── Form inputs management ───────────────────────────────────────────────

  function renderFormInputs() {
    formInputsList.innerHTML = '';
    formInputs.forEach((inp, idx) => {
      const row = document.createElement('div');
      row.className = 'yaml-input-row';

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'text-input yaml-input-name';
      nameInput.placeholder = L.placeholderInputName;
      nameInput.value = inp.name;
      nameInput.addEventListener('input', () => {
        formInputs[idx].name = nameInput.value;
      });

      const labelInput = document.createElement('input');
      labelInput.type = 'text';
      labelInput.className = 'text-input yaml-input-label';
      labelInput.placeholder = L.placeholderInputLabel;
      labelInput.value = inp.label;
      labelInput.addEventListener('input', () => {
        formInputs[idx].label = labelInput.value;
      });

      const typeSelect = document.createElement('select');
      typeSelect.className = 'text-input yaml-input-type-select';
      const optString = document.createElement('option');
      optString.value = 'string';
      optString.textContent = L.typeString;
      const optPicklist = document.createElement('option');
      optPicklist.value = 'picklist';
      optPicklist.textContent = L.typePicklist;
      const optCheckbox = document.createElement('option');
      optCheckbox.value = 'checkbox';
      optCheckbox.textContent = L.typeCheckbox;
      typeSelect.appendChild(optString);
      typeSelect.appendChild(optPicklist);
      typeSelect.appendChild(optCheckbox);
      typeSelect.value = inp.type;

      const reqLabel = document.createElement('label');
      reqLabel.className = 'yaml-input-required-label';
      const reqCheck = document.createElement('input');
      reqCheck.type = 'checkbox';
      reqCheck.checked = inp.required;
      reqCheck.addEventListener('change', () => {
        formInputs[idx].required = reqCheck.checked;
      });
      reqLabel.appendChild(reqCheck);
      reqLabel.appendChild(document.createTextNode(L.labelRequired));

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'btn yaml-input-remove-btn';
      removeBtn.textContent = L.btnRemoveInput;
      removeBtn.addEventListener('click', () => {
        formInputs.splice(idx, 1);
        renderFormInputs();
      });

      row.appendChild(nameInput);
      row.appendChild(labelInput);
      row.appendChild(typeSelect);
      row.appendChild(reqLabel);
      row.appendChild(removeBtn);
      formInputsList.appendChild(row);

      // Options row for picklist (shown/hidden based on type)
      const optionsRow = document.createElement('div');
      optionsRow.className = 'yaml-input-options-row';
      const optionsInput = document.createElement('input');
      optionsInput.type = 'text';
      optionsInput.className = 'text-input';
      optionsInput.placeholder = L.placeholderOptions;
      optionsInput.value = inp.options;
      optionsInput.addEventListener('input', () => {
        formInputs[idx].options = optionsInput.value;
      });
      optionsRow.appendChild(optionsInput);
      optionsRow.style.display = inp.type === 'picklist' ? '' : 'none';
      formInputsList.appendChild(optionsRow);

      // Default-checked row for checkbox (shown/hidden based on type)
      const defaultRow = document.createElement('div');
      defaultRow.className = 'yaml-input-options-row yaml-input-default-row';
      const defaultLabel = document.createElement('label');
      defaultLabel.className = 'yaml-input-required-label';
      const defaultCheck = document.createElement('input');
      defaultCheck.type = 'checkbox';
      defaultCheck.checked = inp.checkboxDefault;
      defaultCheck.addEventListener('change', () => {
        formInputs[idx].checkboxDefault = defaultCheck.checked;
      });
      defaultLabel.appendChild(defaultCheck);
      defaultLabel.appendChild(document.createTextNode(L.labelCheckboxDefault));
      defaultRow.appendChild(defaultLabel);
      defaultRow.style.display = inp.type === 'checkbox' ? '' : 'none';
      formInputsList.appendChild(defaultRow);

      typeSelect.addEventListener('change', () => {
        formInputs[idx].type = /** @type {'string' | 'picklist' | 'checkbox'} */ (typeSelect.value);
        optionsRow.style.display = typeSelect.value === 'picklist' ? '' : 'none';
        defaultRow.style.display = typeSelect.value === 'checkbox' ? '' : 'none';
      });
    });
  }

  addInputBtn.addEventListener('click', () => {
    formInputs.push({
      name: '',
      label: '',
      type: 'string',
      required: false,
      options: '',
      checkboxDefault: false,
    });
    renderFormInputs();
    // Focus the last name input
    const lastNameInput = /** @type {HTMLInputElement | null} */ (
      formInputsList.querySelector('.yaml-input-row:last-of-type .yaml-input-name')
    );
    if (lastNameInput) lastNameInput.focus();
  });

  // ── New Script form ────────────────────────────────────────────────────────

  function updateContentPlaceholder() {
    const placeholders = {
      apex: L.placeholderApexContent,
      command: L.placeholderCommandContent,
      js: L.placeholderJsContent,
    };
    formContent.placeholder =
      placeholders[/** @type {'apex'|'command'|'js'} */ (formType.value)] ??
      L.placeholderApexContent;
  }

  function updateSourceMode() {
    const isFile = formSource.value === 'file';
    const contentRow = formContent.closest('.yaml-form-row');
    if (contentRow) /** @type {HTMLElement} */ (contentRow).style.display = isFile ? 'none' : '';
    formFileRow.style.display = isFile ? '' : 'none';
  }

  function updateSaveBtn() {
    formSaveBtn.disabled = formFolder.value.trim() === '';
  }

  function resetForm() {
    formName.value = '';
    formDescription.value = '';
    formType.value = 'apex';
    formFolder.value = '';
    formSource.value = 'inline';
    formFilePath.value = '';
    formContent.value = '';
    formError.textContent = '';
    formInputs = [];
    renderFormInputs();
    updateContentPlaceholder();
    updateSourceMode();
    updateSaveBtn();
  }

  function refreshDropdown() {
    const folders = [...new Set(currentScripts.map((s) => s.folder))].sort();
    folderDropdown.innerHTML = '';
    for (const folder of folders) {
      const opt = document.createElement('div');
      opt.className = 'yaml-folder-option';
      opt.textContent = folder;
      opt.addEventListener('mousedown', (e) => {
        e.preventDefault(); // prevent input blur before value is set
        formFolder.value = folder;
        folderDropdown.classList.remove('open');
        updateSaveBtn();
      });
      folderDropdown.appendChild(opt);
    }
  }

  function openDropdown() {
    if (folderDropdown.children.length > 0) {
      folderDropdown.classList.add('open');
    }
  }

  function closeDropdown() {
    folderDropdown.classList.remove('open');
  }

  folderToggle.addEventListener('click', () => {
    if (folderDropdown.classList.contains('open')) {
      closeDropdown();
    } else {
      openDropdown();
    }
    formFolder.focus();
  });

  document.addEventListener('click', (e) => {
    const combobox = formFolder.closest('.yaml-folder-combobox');
    if (combobox && !combobox.contains(/** @type {Node} */ (e.target))) {
      closeDropdown();
    }
  });

  function showNewForm() {
    editingScriptId = null;
    editingScriptSource = null;
    formDeleteBtn.style.display = 'none';
    formPrivate.checked = false;
    resetForm();
    refreshDropdown();
    newForm.style.display = '';
    newBtn.disabled = true;
    formName.focus();
  }

  /**
   * @param {{ id: string; folder: string; name: string; description: string; type: 'apex' | 'command' | 'js'; script: string; scriptFile?: string; invalid?: true; source?: 'builtin' | 'user' | 'private'; inputs?: Array<{ name: string; label?: string; type?: 'string' | 'picklist' | 'checkbox'; required?: boolean; options?: string[]; default?: boolean }> }} script
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
    formContent.value = script.scriptFile ? '' : (script.script ?? '');
    formError.textContent = '';
    formInputs = (script.inputs || []).map((/** @type {any} */ inp) => ({
      name: inp.name || '',
      label: inp.label || '',
      type: inp.type === 'picklist' ? 'picklist' : inp.type === 'checkbox' ? 'checkbox' : 'string',
      required: !!inp.required,
      options: inp.type === 'picklist' && Array.isArray(inp.options) ? inp.options.join(', ') : '',
      checkboxDefault: inp.type === 'checkbox' ? inp.default === true : false,
    }));
    renderFormInputs();
    updateContentPlaceholder();
    updateSourceMode();
    updateSaveBtn();
    formDeleteBtn.textContent = L.btnDelete;
    formDeleteBtn.style.display = '';
    refreshDropdown();
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
  formType.addEventListener('change', updateContentPlaceholder);
  formSource.addEventListener('change', updateSourceMode);
  formFolder.addEventListener('input', updateSaveBtn);
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
    const contentVal = formContent.value.trim();
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
    const cleanedInputs = formInputs
      .filter((inp) => inp.name.trim())
      .map((inp) => {
        /** @type {{ name: string; label?: string; type?: 'picklist' | 'checkbox'; required?: boolean; options?: string[]; default?: boolean }} */
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
    const query = searchInput.value.toLowerCase().trim();
    const accordions = scriptsList.querySelectorAll('.accordion');
    let visible = 0;

    accordions.forEach((el) => {
      const section = /** @type {HTMLElement} */ (el);
      const folder = section.getAttribute('data-folder') ?? '';
      const source = section.getAttribute('data-source') ?? '';
      const searchText = (section.getAttribute('data-search-text') ?? '').toLowerCase();

      const visibilityMatch =
        activeVisibility === 'all' ||
        (activeVisibility === 'private' && source === 'private') ||
        (activeVisibility === 'shared' && (source === 'user' || source === 'builtin'));

      let folderMatch;
      if (activeFolderFilter === 'all') {
        folderMatch = true;
      } else if (activeSubFolder !== null) {
        folderMatch = folder === activeSubFolder;
      } else {
        // Top-level: match exact or anything starting with "parentFolder/"
        folderMatch = folder === activeFolderFilter || folder.startsWith(activeFolderFilter + '/');
      }

      const textMatch = !query || searchText.includes(query);
      const show = visibilityMatch && folderMatch && textMatch;

      section.style.display = show ? '' : 'none';
      if (show) visible++;
    });

    noResults.style.display = visible === 0 && accordions.length > 0 ? 'block' : 'none';
    noResults.textContent = L.noResults;
  }

  searchInput.addEventListener('input', applyFilters);

  // ── Pill buttons ──────────────────────────────────────────────────────────

  /**
   * @param {string[]} folders - all folders from scripts currently visible under active visibility
   */
  function buildPills(folders) {
    pillsContainer.innerHTML = '';
    subPillsEl.innerHTML = '';
    subPillsEl.classList.remove('visible');
    activeFolderFilter = 'all';
    activeSubFolder = null;

    // Only show top-level folder names as primary pills
    const topLevelFolders = [...new Set(folders.map((f) => f.split('/')[0]))].sort();

    const allPill = document.createElement('button');
    allPill.className = 'category-pill active';
    allPill.textContent = L.pillAll;
    allPill.addEventListener('click', () => setActiveFolder('all', allPill));
    pillsContainer.appendChild(allPill);

    for (const topFolder of topLevelFolders) {
      const pill = document.createElement('button');
      pill.className = 'category-pill';
      pill.textContent = topFolder;
      pill.addEventListener('click', () => {
        setActiveFolder(topFolder, pill);
        // Build sub-category pills for this parent
        const subFolders = folders
          .filter((f) => f.startsWith(topFolder + '/'))
          .map((f) => f.slice(topFolder.length + 1));
        buildSubPills(topFolder, subFolders);
      });
      pillsContainer.appendChild(pill);
    }
  }

  /**
   * @param {string} parentFolder
   * @param {string[]} subFolders - child portion only (e.g. 'advanced' from 'orders/advanced')
   */
  function buildSubPills(parentFolder, subFolders) {
    subPillsEl.innerHTML = '';
    if (subFolders.length === 0) {
      subPillsEl.classList.remove('visible');
      return;
    }
    subPillsEl.classList.add('visible');
    activeSubFolder = null;

    const allSubPill = document.createElement('button');
    allSubPill.className = 'category-pill active';
    allSubPill.textContent = L.pillSubAll;
    allSubPill.addEventListener('click', () => {
      activeSubFolder = null;
      subPillsEl.querySelectorAll('.category-pill').forEach((p) => {
        p.classList.toggle('active', p === allSubPill);
      });
      applyFilters();
    });
    subPillsEl.appendChild(allSubPill);

    for (const sub of [...new Set(subFolders)].sort()) {
      const pill = document.createElement('button');
      pill.className = 'category-pill';
      pill.textContent = sub;
      pill.addEventListener('click', () => {
        activeSubFolder = `${parentFolder}/${sub}`;
        subPillsEl.querySelectorAll('.category-pill').forEach((p) => {
          p.classList.toggle('active', p === pill);
        });
        applyFilters();
      });
      subPillsEl.appendChild(pill);
    }
  }

  /**
   * @param {string} folder
   * @param {HTMLButtonElement} activePill
   */
  function setActiveFolder(folder, activePill) {
    activeFolderFilter = folder;
    activeSubFolder = null;
    subPillsEl.innerHTML = '';
    subPillsEl.classList.remove('visible');
    pillsContainer.querySelectorAll('.category-pill').forEach((p) => {
      p.classList.toggle('active', p === activePill);
    });
    applyFilters();
  }

  // ── Accordion helpers ────────────────────────────────────────────────────

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
        fileLink.addEventListener('click', (e) => {
          e.stopPropagation();
          win.__vscode.postMessage({ type: 'openScriptFile', filePath: script.scriptFile });
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
    badge.textContent = L.badgePrivate;
    badge.title = L.labelPrivate;
    return badge;
  }

  /**
   * @param {any} script
   * @returns {HTMLButtonElement}
   */
  function createEditButton(script) {
    const btn = /** @type {HTMLButtonElement} */ (document.createElement('button'));
    btn.className = 'btn yaml-edit-btn';
    btn.textContent = L.btnEdit;
    btn.title = L.tooltipEditScript;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      showEditForm(script);
    });
    return btn;
  }

  /**
   * @param {any} script
   * @returns {HTMLElement}
   */
  function createTypeBadge(script) {
    const isJs = script.type === 'js';
    const isCmd = script.type === 'command';
    const span = document.createElement('span');
    span.className =
      'script-type-badge ' +
      (isJs ? 'script-type-badge--js' : isCmd ? 'script-type-badge--command' : 'script-type-badge--apex');
    span.textContent = isJs ? L.badgeJs : isCmd ? L.badgeCommand : L.badgeApex;
    return span;
  }

  /**
   * @param {any} script
   * @returns {HTMLElement}
   */
  function buildInvalidAccordion(script) {
    const section = createAccordionSection(script, 'open yaml-script--invalid');
    const header = document.createElement('div');
    header.className = 'yaml-script-header';

    header.appendChild(createTriggerButton(script, section));

    const invalidBadge = document.createElement('span');
    invalidBadge.className = 'script-invalid-badge';
    invalidBadge.textContent = L.badgeInvalid;
    header.appendChild(invalidBadge);

    if (script.source === 'private') header.appendChild(createPrivateBadge());
    header.appendChild(createEditButton(script));

    const executeBtn = document.createElement('button');
    executeBtn.className = 'btn yaml-execute-btn';
    executeBtn.textContent = L.btnExecute;
    executeBtn.disabled = true;
    executeBtn.title = L.tooltipInvalidScript;
    header.appendChild(executeBtn);

    const body = document.createElement('div');
    body.className = 'accordion-body';
    const errorBox = document.createElement('div');
    errorBox.className = 'error-box';
    errorBox.textContent = script.error ?? L.badgeInvalid;
    body.appendChild(errorBox);

    section.appendChild(header);
    section.appendChild(body);
    return section;
  }

  /**
   * @param {any} script
   * @param {() => void} updateExecuteState
   * @returns {{ element: HTMLElement | null, inputFields: Map<string, HTMLInputElement | HTMLSelectElement> }}
   */
  function buildInputFields(script, updateExecuteState) {
    /** @type {Map<string, HTMLInputElement | HTMLSelectElement>} */
    const inputFields = new Map();
    if (!script.inputs || script.inputs.length === 0) {
      return { element: null, inputFields };
    }

    const inputsForm = document.createElement('div');
    inputsForm.className = 'yaml-inputs-form';

    for (const inp of script.inputs) {
      const fieldDiv = document.createElement('div');
      fieldDiv.className = 'yaml-input-field';

      if (inp.type === 'checkbox') {
        const checkboxLabel = document.createElement('label');
        checkboxLabel.className = 'yaml-input-checkbox-label';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = inp.default === true;
        cb.addEventListener('change', updateExecuteState);
        inputFields.set(inp.name, cb);
        const span = document.createElement('span');
        span.textContent = inp.label || inp.name;
        checkboxLabel.appendChild(cb);
        checkboxLabel.appendChild(span);
        fieldDiv.appendChild(checkboxLabel);
      } else {
        const label = document.createElement('label');
        label.className = 'form-label';
        label.textContent = inp.label || inp.name;
        if (inp.required) {
          const reqStar = document.createElement('span');
          reqStar.className = 'yaml-input-required-star';
          reqStar.textContent = ' *';
          label.appendChild(reqStar);
        }
        fieldDiv.appendChild(label);

        if (inp.type === 'picklist' && inp.options && inp.options.length > 0) {
          const select = document.createElement('select');
          select.className = 'text-input';
          for (const opt of inp.options) {
            const option = document.createElement('option');
            option.value = opt;
            option.textContent = opt;
            select.appendChild(option);
          }
          select.addEventListener('change', updateExecuteState);
          inputFields.set(inp.name, select);
          fieldDiv.appendChild(select);
        } else {
          const input = document.createElement('input');
          input.type = 'text';
          input.className = 'text-input';
          input.placeholder = inp.label || inp.name;
          input.addEventListener('input', updateExecuteState);
          inputFields.set(inp.name, input);
          const pasteWrapper = document.createElement('div');
          pasteWrapper.className = 'input-with-paste';
          const pasteBtn = document.createElement('button');
          pasteBtn.type = 'button';
          pasteBtn.className = 'paste-btn';
          pasteBtn.title = 'Paste from clipboard';
          pasteBtn.textContent = '📋';
          pasteWrapper.appendChild(input);
          pasteWrapper.appendChild(pasteBtn);
          fieldDiv.appendChild(pasteWrapper);
        }
      }

      inputsForm.appendChild(fieldDiv);
    }

    return { element: inputsForm, inputFields };
  }

  /**
   * @typedef {Object} LogViewerRefs
   * @property {HTMLElement} statusHint
   * @property {HTMLElement} errorBox
   * @property {HTMLElement} logViewer
   * @property {HTMLPreElement} logOutput
   * @property {HTMLButtonElement} openInEditorBtn
   */

  /**
   * @param {any} script
   * @param {HTMLElement} section
   * @returns {{ fragment: DocumentFragment, refs: LogViewerRefs }}
   */
  function buildLogViewer(script, section) {
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

    if (isApex) {
      const filterLabel = document.createElement('label');
      filterLabel.className = 'yaml-log-filter-label';
      const filterCheckbox = document.createElement('input');
      filterCheckbox.type = 'checkbox';
      filterCheckbox.className = 'yaml-log-filter-checkbox';
      filterLabel.appendChild(filterCheckbox);
      filterLabel.appendChild(document.createTextNode(L.checkboxUserDebugOnly));
      logViewer.appendChild(filterLabel);
      filterCheckbox.addEventListener('change', () => {
        const rawLog = logOutput.getAttribute('data-raw-log') ?? '';
        const filteredLog = logOutput.getAttribute('data-filtered-log') ?? '';
        logOutput.textContent = filterCheckbox.checked && filteredLog ? filteredLog : rawLog;
      });
    }

    logViewer.appendChild(logOutput);

    const openInEditorBtn = /** @type {HTMLButtonElement} */ (document.createElement('button'));
    openInEditorBtn.className = 'yaml-open-editor-btn';
    openInEditorBtn.textContent = 'Open in editor';
    openInEditorBtn.style.display = 'none';
    openInEditorBtn.addEventListener('click', () => {
      const filterCheckbox = /** @type {HTMLInputElement | null} */ (
        section.querySelector('.yaml-log-filter-checkbox')
      );
      const raw = logOutput.getAttribute('data-raw-log') || '';
      const content = filterCheckbox?.checked ? logOutput.textContent || '' : raw;
      win.__vscode.postMessage({ type: 'openScriptResult', content });
    });
    logViewer.appendChild(openInEditorBtn);

    fragment.appendChild(statusHint);
    fragment.appendChild(errorBox);
    fragment.appendChild(logViewer);

    return { fragment, refs: { statusHint, errorBox, logViewer, logOutput, openInEditorBtn } };
  }

  /**
   * @param {Object} params
   * @param {any} params.script
   * @param {HTMLElement} params.section
   * @param {HTMLButtonElement} params.executeBtn
   * @param {boolean} params.needsOrg
   * @param {Map<string, HTMLInputElement | HTMLSelectElement>} params.inputFields
   * @param {LogViewerRefs} params.refs
   */
  function attachExecuteHandler({ script, section, executeBtn, needsOrg, inputFields, refs }) {
    const { statusHint, errorBox, logViewer, logOutput, openInEditorBtn } = refs;

    executeBtn.addEventListener('click', () => {
      if (needsOrg && !connected) return;

      /** @type {Record<string, string>} */
      const inputValues = {};
      inputFields.forEach((field, name) => {
        if (field instanceof HTMLInputElement && field.type === 'checkbox') {
          inputValues[name] = field.checked ? 'true' : 'false';
        } else {
          inputValues[name] = field.value;
        }
      });

      /** @type {string | null} */
      let _scriptOpId = null;

      function doExecute() {
        statusHint.textContent = L.statusExecuting;
        errorBox.textContent = '';
        logViewer.style.display = 'none';
        logOutput.textContent = '';
        logOutput.classList.remove('yaml-log-output--success', 'yaml-log-output--error');
        openInEditorBtn.style.display = 'none';

        const filterCheckbox = /** @type {HTMLInputElement | null} */ (
          section.querySelector('.yaml-log-filter-checkbox')
        );
        if (filterCheckbox) filterCheckbox.checked = false;

        section.classList.add('open');
        _scriptOpId = win.__startAction(executeBtn, () => {
          statusHint.textContent = '';
          win.__vscode.postMessage({ type: 'cancelOperation', opId: _scriptOpId });
        });
        win.__vscode.postMessage({
          type: 'executeYamlScript',
          scriptId: script.id,
          inputs: inputValues,
          opId: _scriptOpId,
        });
      }

      win.__confirmIfSensitive(currentOrgData, 'Execute this script?', doExecute, () => {});
    });
  }

  // ── Build accordion per script ────────────────────────────────────────────

  /**
   * @param {{ id: string; folder: string; name: string; description: string; type: 'apex' | 'command' | 'js'; script: string; scriptFile?: string; source: 'builtin' | 'user' | 'private'; invalid?: true; error?: string; inputs?: Array<{ name: string; label?: string; type?: 'string' | 'picklist' | 'checkbox'; required?: boolean; options?: string[]; default?: boolean }> }} script
   * @returns {HTMLElement}
   */
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
    executeBtn.textContent = L.btnExecute;
    executeBtn.disabled = needsOrg ? !connected : false;

    header.appendChild(createTriggerButton(script, section));
    header.appendChild(createTypeBadge(script));
    if (script.source === 'private') header.appendChild(createPrivateBadge());
    if (script.source !== 'builtin') header.appendChild(createEditButton(script));
    header.appendChild(executeBtn);

    // ── Body ──
    const body = document.createElement('div');
    body.className = 'accordion-body';

    // Input fields + execute state management
    const hasInputs = script.inputs && script.inputs.length > 0;

    function updateExecuteState() {
      const orgOk = needsOrg ? connected : true;
      if (!hasInputs) {
        executeBtn.disabled = !orgOk;
        return;
      }
      const allRequiredFilled = (script.inputs || []).every((/** @type {any} */ inp) => {
        if (!inp.required) return true;
        const field = inputFields.get(inp.name);
        if (!field) return false;
        if (field instanceof HTMLInputElement && field.type === 'checkbox') return true;
        return field.value.trim() !== '';
      });
      executeBtn.disabled = !(orgOk && allRequiredFilled);
    }

    const { element: inputsEl, inputFields } = buildInputFields(script, updateExecuteState);
    if (inputsEl) body.appendChild(inputsEl);
    executeStateUpdaters.set(script.id, updateExecuteState);

    if (hasInputs && (script.inputs || []).some((/** @type {any} */ inp) => inp.required)) {
      executeBtn.disabled = true;
    }

    // Log viewer
    const { fragment, refs } = buildLogViewer(script, section);
    body.appendChild(fragment);

    section.appendChild(header);
    section.appendChild(body);

    attachExecuteHandler({ script, section, executeBtn, needsOrg, inputFields, refs });

    return section;
  }

  /** @param {string} str @returns {string} */
  function escapeHtml(str) {
    return win.__escapeHtml(str);
  }

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

    // Build visibility filter (All / Shared / Private)
    activeVisibility = 'all';
    buildVisibilityFilter();

    // Collect unique folders from currently-visible scripts
    const visibleForPills = getVisibleScripts(scripts);
    const folders = [...new Set(visibleForPills.map((s) => s.folder))].sort();
    buildPills(folders);

    // Populate folder dropdown for the new-script form
    refreshDropdown();

    for (const script of scripts) {
      scriptsList.appendChild(buildAccordion(script));
    }

    applyFilters();

    // After save: scroll new script into view and briefly highlight it
    if (lastSavedScriptId) {
      const savedId = lastSavedScriptId;
      lastSavedScriptId = null;
      requestAnimationFrame(() => {
        const el = /** @type {HTMLElement | null} */ (
          scriptsList.querySelector(`[data-script-id="${CSS.escape(savedId)}"]`)
        );
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          el.classList.add('yaml-script--highlight');
          setTimeout(() => el.classList.remove('yaml-script--highlight'), 1500);
        }
      });
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

    // __endAction re-enables the button; then re-evaluate state (e.g. org may have disconnected)
    win.__endAction(data.opId);
    const updater = executeStateUpdaters.get(data.scriptId);
    if (updater) updater();

    if (data.cancelled) {
      statusHint.textContent = '';
      return; // killed mid-run — no output to show
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
    if (data.debugLog) {
      logOutput.setAttribute('data-raw-log', data.debugLog);
      if (data.filteredDebugLog) {
        logOutput.setAttribute('data-filtered-log', data.filteredDebugLog);
      }
      logOutput.textContent = filterCheckbox?.checked && data.filteredDebugLog
        ? data.filteredDebugLog
        : data.debugLog;
      logOutput.classList.add(data.success ? 'yaml-log-output--success' : 'yaml-log-output--error');
      logViewer.style.display = 'block';
      openInEditorBtn.style.display = '';
    } else {
      openInEditorBtn.style.display = 'none';
    }
  }

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
      }
    },
    onOrgDisconnected: () => {
      connected = false;
      currentOrgData = null;
      updateExecuteBtns();
    },
    /** @param {{ type: string; data: any }} message */
    onMessage: (message) => {
      switch (message.type) {
        case 'loadYamlScriptsResult':
          renderScripts(message.data.scripts ?? []);
          break;
        case 'loadYamlScriptsError':
          loadError.textContent = message.data?.message ?? 'Failed to load scripts.';
          break;
        case 'executeYamlScriptResult':
          handleExecuteResult(message.data);
          break;
        case 'executeYamlScriptError':
          // Unexpected throw from service — end the action and show error
          win.__endAction(message.data?.opId);
          break;
        case 'saveYamlScriptResult':
          lastSavedScriptId = message.data?.script?.id ?? null;
          hideNewForm();
          win.__vscode.postMessage({ type: 'loadYamlScripts' });
          break;
        case 'saveYamlScriptError':
          formSaveBtn.disabled = false;
          formError.textContent = message.data?.message ?? 'Failed to save script.';
          break;
        case 'updateYamlScriptResult':
          lastSavedScriptId = message.data?.script?.id ?? null;
          hideNewForm();
          win.__vscode.postMessage({ type: 'loadYamlScripts' });
          break;
        case 'updateYamlScriptError':
          formSaveBtn.disabled = false;
          formError.textContent = message.data?.message ?? 'Failed to update script.';
          break;
        case 'deleteYamlScriptResult':
          if (message.data?.deleted) {
            hideNewForm();
            win.__vscode.postMessage({ type: 'loadYamlScripts' });
          }
          // deleted === false means user cancelled the dialog — do nothing
          break;
        case 'deleteYamlScriptError':
          formError.textContent = message.data?.message ?? 'Failed to delete script.';
          break;
        case 'browseForScriptFileResult':
          if (!message.data?.cancelled) {
            formFilePath.value = message.data?.filePath ?? '';
          }
          break;
      }
    },
  });
})();

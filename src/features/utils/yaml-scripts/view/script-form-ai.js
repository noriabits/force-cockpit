// @ts-check
// AI-only sub-controller for the script form: model picker, skills picker,
// and the optional gather step (visibility + payload assembly). Owns its own
// state and event wiring; the orchestrator only calls the returned API.

/**
 * @typedef {{
 *   formModel: HTMLSelectElement, formModelHint: HTMLElement,
 *   formGatherEnabled: HTMLInputElement, formGatherBody: HTMLElement, formGatherType: HTMLSelectElement,
 *   formGatherContent: HTMLTextAreaElement, formGatherFileRow: HTMLElement,
 *   formGatherFilePath: HTMLInputElement, formGatherBrowseBtn: HTMLButtonElement,
 *   formAllowFollowup: HTMLInputElement, formAllowReadFiles: HTMLInputElement,
 *   formSkills: HTMLElement, formSkillsHint: HTMLElement,
 * }} AiFormRefs
 */

/**
 * @param {{
 *   refs: AiFormRefs,
 *   labels: any,
 *   vscode: { postMessage: (msg: any) => void },
 *   updateSaveBtn: () => void,
 * }} ctx
 */
export function createAiFields(ctx) {
  const { refs, labels: L, vscode, updateSaveBtn } = ctx;
  const {
    formModel,
    formModelHint,
    formGatherEnabled,
    formGatherBody,
    formGatherType,
    formGatherContent,
    formGatherFileRow,
    formGatherFilePath,
    formGatherBrowseBtn,
    formAllowFollowup,
    formAllowReadFiles,
    formSkills,
    formSkillsHint,
  } = refs;

  /** Which file picker is in flight: the prompt file (handled by the orchestrator), or the gather Apex file. */
  let pendingGatherBrowse = false;

  /**
   * Show/hide the AI-only rows based on whether the script type is 'ai'.
   * @param {boolean} isAi
   */
  function updateAiVisibility(isAi) {
    const aiRows = document.querySelectorAll('.yaml-form-ai-only');
    aiRows.forEach((row) => {
      /** @type {HTMLElement} */ (row).style.display = isAi ? '' : 'none';
    });
    if (isAi) updateGatherEnabled();
  }

  /** The gather step is optional: reveal its controls only when the box is checked. */
  function updateGatherEnabled() {
    formGatherBody.style.display = formGatherEnabled.checked ? '' : 'none';
    if (formGatherEnabled.checked) updateGatherMode();
  }

  /** Within an AI gather step, toggle the inline textarea vs the Apex-file picker. */
  function updateGatherMode() {
    const isFile = formGatherType.value === 'apex-file';
    formGatherContent.style.display = isFile ? 'none' : '';
    formGatherFileRow.style.display = isFile ? '' : 'none';
    formGatherContent.placeholder =
      formGatherType.value === 'soql' ? L.placeholderGatherSoql : L.placeholderGatherApex;
  }

  /** True when the gather step is enabled and its content/file is filled in. */
  function gatherFilled() {
    if (!formGatherEnabled.checked) return false;
    return formGatherType.value === 'apex-file'
      ? formGatherFilePath.value.trim() !== ''
      : formGatherContent.value.trim() !== '';
  }

  // ── Model picker (populated from the async listChatModels round-trip) ──────
  // The model choice is mandatory: '' means "nothing picked yet" (the disabled
  // placeholder option), which keeps the Save button disabled for AI scripts.
  let pendingModelSelection = '';

  /**
   * The value of Copilot's "Auto" model option, or '' if not present. Detected
   * leniently: a model whose name or id is "auto" (case-insensitive). Kept in
   * sync with the gateway-side detection in LmGateway.ts.
   */
  function findAutoOptionValue() {
    const opt = Array.from(formModel.options).find(
      (o) =>
        o.value !== '' &&
        (o.text.trim().toLowerCase() === 'auto' || o.value.toLowerCase() === 'auto'),
    );
    return opt ? opt.value : '';
  }

  function applyPendingModel() {
    const has =
      pendingModelSelection !== '' &&
      Array.from(formModel.options).some((o) => o.value === pendingModelSelection);
    // With no valid prior choice, default to Auto when available, else leave the
    // (disabled) placeholder selected.
    formModel.value = has ? pendingModelSelection : findAutoOptionValue();
  }

  /** @param {Array<{ id: string; name?: string; family?: string }>} models */
  function setModels(models) {
    pendingModelSelection = formModel.value || pendingModelSelection || '';
    while (formModel.options.length > 1) formModel.remove(1);
    const sorted = models
      .slice()
      .sort((a, b) =>
        (a.name || a.id).localeCompare(b.name || b.id, undefined, { sensitivity: 'base' }),
      );
    for (const m of sorted) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.text = m.name || m.id;
      formModel.appendChild(opt);
    }
    applyPendingModel();
    if (formModelHint) {
      const none = models.length === 0;
      formModelHint.style.display = none ? '' : 'none';
      formModelHint.textContent = none ? L.modelHintNone : '';
    }
    updateSaveBtn();
  }

  // ── Skills picker (populated from the async listSkills round-trip) ─────────
  /** @type {string[]} */
  let pendingSkillSelection = [];

  /** Currently checked skill ids in the DOM. */
  function checkedSkillIds() {
    return Array.from(formSkills.querySelectorAll('input[type="checkbox"]:checked')).map(
      (el) => /** @type {HTMLInputElement} */ (el).value,
    );
  }

  /**
   * @param {Array<{ id: string; name?: string; description?: string }>} skills
   * @param {boolean} [preserve] When true (default), promote any in-progress DOM
   *   checks to `pendingSkillSelection` (mirrors the model picker's re-fetch). Pass
   *   `false` when initializing the form so a previously edited script's stale
   *   checkboxes don't clobber the freshly assigned `pendingSkillSelection`.
   */
  function setSkills(skills, preserve = true) {
    if (preserve) {
      const current = checkedSkillIds();
      if (current.length) pendingSkillSelection = current;
    }
    formSkills.textContent = '';
    for (const s of skills) {
      const label = document.createElement('label');
      label.className = 'yaml-form-skill-option';
      if (s.description) /** @type {any} */ (window).__setTooltip(label, s.description);
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = s.id;
      cb.checked = pendingSkillSelection.includes(s.id);
      const span = document.createElement('span');
      span.textContent = s.name || s.id;
      label.appendChild(cb);
      label.appendChild(span);
      formSkills.appendChild(label);
    }
    const none = skills.length === 0;
    formSkills.style.display = none ? 'none' : '';
    if (formSkillsHint) {
      formSkillsHint.style.display = none ? '' : 'none';
      formSkillsHint.textContent = none ? L.skillsHintNone : '';
    }
  }

  /** Build the ai-only save payload fields (model + optional gather + skills + flags). */
  function buildAiFields() {
    const kind = formGatherType.value;
    /** @type {{ kind: 'soql' | 'apex' | 'apex-file'; value: string; file?: string } | undefined} */
    let gather;
    if (formGatherEnabled.checked) {
      if (kind === 'apex-file') {
        gather = { kind: 'apex-file', value: '', file: formGatherFilePath.value.trim() };
      } else if (kind === 'apex') {
        gather = { kind: 'apex', value: formGatherContent.value };
      } else {
        gather = { kind: 'soql', value: formGatherContent.value };
      }
    }
    const skills = checkedSkillIds();
    return {
      model: formModel.value,
      ...(gather ? { gather } : {}),
      ...(skills.length ? { skills } : {}),
      ...(formAllowFollowup.checked ? { allowFollowupQueries: true } : {}),
      ...(formAllowReadFiles.checked ? { allowReadWorkspaceFiles: true } : {}),
    };
  }

  function reset() {
    pendingModelSelection = '';
    applyPendingModel();
    formGatherEnabled.checked = false;
    formGatherType.value = 'soql';
    formGatherContent.value = '';
    formGatherFilePath.value = '';
    formAllowFollowup.checked = false;
    formAllowReadFiles.checked = false;
    pendingSkillSelection = [];
    setSkills([], false);
  }

  /**
   * @param {{ model?: string; gather?: { kind: 'apex' | 'apex-file' | 'soql'; value: string; file?: string }; allowFollowupQueries?: boolean; allowReadWorkspaceFiles?: boolean; skills?: string[] }} script
   */
  function populateFromScript(script) {
    formModel.value = script.model ?? '';
    const gather = script.gather;
    formGatherEnabled.checked = !!gather;
    formGatherType.value = gather?.kind ?? 'soql';
    formGatherContent.value = gather && gather.kind !== 'apex-file' ? gather.value : '';
    formGatherFilePath.value = gather?.kind === 'apex-file' ? (gather.file ?? '') : '';
    formAllowFollowup.checked = !!script.allowFollowupQueries;
    formAllowReadFiles.checked = !!script.allowReadWorkspaceFiles;
    // Re-apply the model + skills once the (async) lists arrive, in case the
    // saved selections aren't rendered yet.
    pendingModelSelection = script.model ?? '';
    applyPendingModel();
    pendingSkillSelection = Array.isArray(script.skills) ? script.skills.slice() : [];
    setSkills([], false);
  }

  /** Posts the async model/skills list requests (caller gates this on type === 'ai'). */
  function requestLists() {
    vscode.postMessage({ type: 'listChatModels' });
    vscode.postMessage({ type: 'listSkills' });
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────

  formModel.addEventListener('change', updateSaveBtn);
  formGatherEnabled.addEventListener('change', () => {
    updateGatherEnabled();
    updateSaveBtn();
  });
  formGatherType.addEventListener('change', () => {
    updateGatherMode();
    updateSaveBtn();
  });
  formGatherContent.addEventListener('input', updateSaveBtn);
  formGatherFilePath.addEventListener('input', updateSaveBtn);
  formGatherBrowseBtn.addEventListener('click', () => {
    pendingGatherBrowse = true;
    vscode.postMessage({ type: 'browseForScriptFile' });
  });

  return {
    updateAiVisibility,
    gatherFilled,
    setModels,
    setSkills,
    buildAiFields,
    reset,
    populateFromScript,
    requestLists,
    /** Call before posting the orchestrator's own (non-gather) browse request. */
    markPromptBrowseTarget() {
      pendingGatherBrowse = false;
    },
    /**
     * Applies a browsed file path if the in-flight picker was for the gather file.
     * @param {string} filePath
     * @returns {boolean} true if consumed (caller should not also apply it elsewhere)
     */
    applyBrowsedFilePath(filePath) {
      if (!pendingGatherBrowse) return false;
      formGatherFilePath.value = filePath;
      updateSaveBtn();
      return true;
    },
  };
}

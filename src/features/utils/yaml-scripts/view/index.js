// @ts-check
import { renderLogWithLinks, renderLogWithJsonTables } from './log-rendering.js';
import { createAccordionBuilder } from './accordion-builder.js';
import { createScriptForm } from './script-form.js';
import { createLogViewer } from './log-viewer.js';
import { createExecuteHandler } from './execute-handler.js';
import { createCategoryFilterBar } from '../../../shared/view/category-filter-bar.js';
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
  const noResults = /** @type {HTMLElement} */ (document.getElementById('yaml-no-results'));
  const loadError = /** @type {HTMLElement} */ (document.getElementById('yaml-load-error'));

  /** @type {Map<string, string>} Maps opId → scriptId for in-flight executions */
  const opIdToScriptId = new Map();
  /** @type {Map<string, string>} Maps opId → accumulated log text (memory-based, not DOM) */
  const scriptLogContent = new Map();
  /** @type {Map<string, () => void>} */
  const executeStateUpdaters = new Map();

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
  /** @type {{ id: string; folder: string; name: string; description: string; type: 'apex' | 'command' | 'js' | 'ai'; script: string; scriptFile?: string; source: string; invalid?: true; error?: string; filterUserDebug?: boolean; formatJson?: boolean; inputs?: Array<{ name: string; label?: string; type?: 'string' | 'picklist' | 'checkbox'; required?: boolean; options?: string[]; default?: boolean }> }[]} */
  let currentScripts = [];

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

  // ── New/Edit script form (extracted controller) ───────────────────────────

  const scriptForm = createScriptForm({
    labels: L,
    vscode: win.__vscode,
    hljs: win.hljs,
    filterBar,
    getCurrentScripts: () => currentScripts,
  });

  // ── Filtering ─────────────────────────────────────────────────────────────

  function applyFilters() {
    const accordions = /** @type {NodeListOf<HTMLElement>} */ (
      scriptsList.querySelectorAll('.accordion')
    );
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

  // ── Accordion builder (composing log-viewer + execute-handler factories) ──

  const logViewerFactory = createLogViewer({
    labels: L,
    vscode: win.__vscode,
    renderLogWithLinks,
    renderLogWithJsonTables,
  });

  const executeHandlerFactory = createExecuteHandler({
    labels: L,
    vscode: win.__vscode,
    opIdToScriptId,
    getConnected: () => connected,
    getCurrentOrgData: () => currentOrgData,
    startAction: (btn, onCancel) => win.__startAction(btn, onCancel),
    confirmIfSensitive: (orgData, prompt, onConfirmed, onCancelled) =>
      win.__confirmIfSensitive(orgData, prompt, onConfirmed, onCancelled),
  });

  const accordionBuilder = createAccordionBuilder({
    labels: L,
    scriptsList,
    favoriteIds,
    executeStateUpdaters,
    getConnected: () => connected,
    onEditClick: (script) => scriptForm.showEditForm(script),
    vscode: win.__vscode,
    escapeHtml: win.__escapeHtml,
    buildLogViewer: logViewerFactory.buildLogViewer,
    attachExecuteHandler: executeHandlerFactory.attachExecuteHandler,
  });
  const buildAccordion = accordionBuilder.buildAccordion;
  const updateFavoriteStars = accordionBuilder.updateFavoriteStars;

  // ── Render scripts list ───────────────────────────────────────────────────

  /**
   * @param {{ id: string; folder: string; name: string; description: string; type: 'apex' | 'command' | 'js' | 'ai'; script: string; scriptFile?: string; source: 'builtin' | 'user' | 'private'; invalid?: true; error?: string; inputs?: Array<{ name: string; label?: string; type?: 'string' | 'picklist' | 'checkbox'; required?: boolean; options?: string[]; default?: boolean }> }[]} scripts
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
    scriptForm.refreshFolders();

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
      // The "Format JSON" checkbox drives table rendering (default-checked for AI
      // scripts — see log-viewer.js — so SOQL records render as a table).
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
    scriptForm.hideNewForm();
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
    scriptForm.hideNewForm();
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
    scriptForm.hideNewForm();
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
      scriptForm.onSaveError(data?.message ?? 'Failed to save script.');
    },
    updateYamlScriptResult: handleUpdateResult,
    updateYamlScriptError: (data) => {
      scriptForm.onSaveError(data?.message ?? 'Failed to update script.');
    },
    deleteYamlScriptResult: handleDeleteResult,
    deleteYamlScriptError: (data) => {
      scriptForm.onDeleteError(data?.message ?? 'Failed to delete script.');
    },
    loadFavoritesResult: handleFavorites,
    toggleFavoriteResult: handleFavorites,
    browseForScriptFileResult: (data) => {
      if (!data?.cancelled) {
        scriptForm.setFilePath(data?.filePath ?? '');
      }
    },
    listChatModelsResult: (data) => scriptForm.setModels(data?.models ?? []),
    listChatModelsError: () => scriptForm.setModels([]),
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

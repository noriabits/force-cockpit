// @ts-check
// Wires a script accordion's Execute button: input value collection, the
// sensitive-org confirmation flow (always BEFORE __startAction, per
// CLAUDE.md), opId tracking and the executeYamlScript dispatch. The
// opIdToScriptId Map stays owned by index.js and is injected via ctx.

/** @typedef {import('./log-viewer.js').LogViewerRefs} LogViewerRefs */

/**
 * @typedef {Object} ExecuteHandlerCtx
 * @property {any} labels
 * @property {{ postMessage: (msg: any) => void }} vscode
 * @property {Map<string, string>} opIdToScriptId
 * @property {() => boolean} getConnected
 * @property {() => any} getCurrentOrgData
 * @property {(btn: HTMLButtonElement, onCancel: () => void) => string | null} startAction
 * @property {(orgData: any, prompt: string, onConfirmed: () => void, onCancelled?: () => void) => void} confirmIfSensitive
 */

/**
 * @param {ExecuteHandlerCtx} ctx
 */
export function createExecuteHandler(ctx) {
  const {
    labels,
    vscode,
    opIdToScriptId,
    getConnected,
    getCurrentOrgData,
    startAction,
    confirmIfSensitive,
  } = ctx;

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
    const {
      statusHint,
      errorBox,
      logViewer,
      logOutput,
      openInEditorBtn,
      openAsMarkdownBtn,
      copyToClipboardBtn,
    } = refs;

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
        if (openAsMarkdownBtn) openAsMarkdownBtn.style.display = 'none';
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

  return { attachExecuteHandler };
}

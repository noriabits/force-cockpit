// @ts-check
// REST-only sub-controller for the script form: the request line (method +
// endpoint) and the custom-headers editor. Owns its own state and event wiring;
// the orchestrator only calls the returned API. Mirrors script-form-ai.js.

import { createHeadersEditor } from '../../../shared/view/headers-editor';

/**
 * @typedef {{
 *   formRestMethod: HTMLSelectElement, formRestEndpoint: HTMLInputElement,
 *   formRestHeadersList: HTMLElement, formRestAddHeaderBtn: HTMLButtonElement,
 * }} RestFormRefs
 */

/**
 * @param {{ refs: RestFormRefs, updateSaveBtn: () => void }} ctx
 */
export function createRestFields(ctx) {
  const { refs, updateSaveBtn } = ctx;
  const { formRestMethod, formRestEndpoint, formRestHeadersList, formRestAddHeaderBtn } = refs;

  // The same editor the REST tab uses, so both agree on row behaviour and both
  // pick up the global .rest-header-* styles.
  const headersEditor = createHeadersEditor({
    listEl: formRestHeadersList,
    addBtn: formRestAddHeaderBtn,
    onChange: updateSaveBtn,
  });

  /**
   * Show/hide the rest-only rows based on whether the script type is 'rest'.
   * @param {boolean} isRest
   */
  function updateRestVisibility(isRest) {
    document.querySelectorAll('.yaml-form-rest-only').forEach((row) => {
      /** @type {HTMLElement} */ (row).style.display = isRest ? '' : 'none';
    });
  }

  /** True when the endpoint — the one field a request cannot be built without — is filled. */
  function endpointFilled() {
    return formRestEndpoint.value.trim() !== '';
  }

  /** Build the rest-only save payload fields. */
  function buildRestFields() {
    /** @type {Record<string, string>} */
    const headers = {};
    // getHeaders() (not getAllHeaders) — a blank-key row is a half-typed header,
    // and unlike a REST tab request tab this payload is written straight to a
    // YAML file, where an empty key would round-trip as a malformed block.
    for (const { key, value } of headersEditor.getHeaders()) {
      headers[key.trim()] = value;
    }
    return {
      rest: {
        method: formRestMethod.value,
        endpoint: formRestEndpoint.value.trim(),
        ...(Object.keys(headers).length ? { headers } : {}),
      },
    };
  }

  function reset() {
    formRestMethod.value = 'GET';
    formRestEndpoint.value = '';
    headersEditor.setHeaders([]);
  }

  /**
   * @param {{ rest?: { method?: string; endpoint?: string; headers?: Record<string, string> } }} script
   */
  function populateFromScript(script) {
    const rest = script.rest;
    formRestMethod.value = rest?.method ?? 'GET';
    formRestEndpoint.value = rest?.endpoint ?? '';
    headersEditor.setHeaders(
      Object.entries(rest?.headers ?? {}).map(([key, value]) => ({ key, value: String(value) })),
    );
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────

  formRestMethod.addEventListener('change', updateSaveBtn);
  formRestEndpoint.addEventListener('input', updateSaveBtn);

  return {
    updateRestVisibility,
    endpointFilled,
    buildRestFields,
    reset,
    populateFromScript,
  };
}

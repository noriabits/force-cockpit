// @ts-check
// Response rendering for the REST tab: a color-coded status badge, a collapsible
// response-headers list, and a pretty-printed JSON body with clickable Salesforce
// record-Id links (same detector/click pattern as Quick Query's results-table.js
// and Monitoring's table-rendering.js).
import { isSalesforceRecordId } from '../../utils/salesforce';

/**
 * @typedef {Object} ResponseViewCtx
 * @property {HTMLElement} responseEl       Outer response container (toggled show/hide).
 * @property {HTMLElement} errorEl          Error box (toggled show/hide).
 * @property {HTMLElement} metaEl           Status badge text target.
 * @property {HTMLElement} bodyEl           `<pre>` the formatted/linkified body renders into.
 * @property {HTMLButtonElement} headersToggleBtn
 * @property {HTMLElement} headersListEl
 * @property {{ postMessage: (msg: any) => void }} vscode
 * @property {(str: any) => string} escapeHtml
 */

const STATUS_SUFFIXES = ['ok', 'warn', 'error'];
const STATUS_CLASSES = STATUS_SUFFIXES.map((s) => `rest-response-status--${s}`);
const BODY_BORDER_CLASSES = STATUS_SUFFIXES.map((s) => `rest-response-body--${s}`);

/** @param {ResponseViewCtx} ctx */
export function createResponseView(ctx) {
  const {
    responseEl,
    errorEl,
    metaEl,
    bodyEl,
    headersToggleBtn,
    headersListEl,
    vscode,
    escapeHtml,
  } = ctx;

  let headersOpen = false;

  /** @param {number} status @returns {'ok' | 'warn' | 'error'} */
  function statusSuffix(status) {
    if (status >= 200 && status < 300) return 'ok';
    if (status >= 500) return 'error';
    return 'warn';
  }

  /** @param {Record<string, string>} headers */
  function renderHeadersList(headers) {
    headersListEl.innerHTML = '';
    const entries = Object.entries(headers || {});
    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'rest-response-headers-empty';
      empty.textContent = 'No response headers.';
      headersListEl.appendChild(empty);
      return;
    }
    for (const [key, value] of entries) {
      const row = document.createElement('div');
      row.className = 'rest-response-header-row';
      row.textContent = `${key}: ${value}`;
      headersListEl.appendChild(row);
    }
  }

  /**
   * Pretty-prints the body, then wraps quoted 18-char Salesforce Ids as clickable
   * links. Escapes the FULL text first — the regex only ever matches already-escaped
   * checksum-validated tokens, so it can never reintroduce markup from an untrusted
   * response body.
   * @param {unknown} body
   */
  function formatBodyHtml(body) {
    /** @type {unknown} */
    let parsed = body;
    if (typeof body === 'string') {
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = body;
      }
    }
    let text;
    try {
      text = typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2);
    } catch {
      text = String(parsed);
    }
    const escaped = escapeHtml(text);
    return escaped.replace(/&quot;([a-zA-Z0-9]{18})&quot;/g, (match, id) => {
      if (!isSalesforceRecordId(id)) return match;
      return `&quot;<a href="#" class="rest-response-id-link" data-record-id="${id}">${id}</a>&quot;`;
    });
  }

  bodyEl.addEventListener('click', (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    if (target.tagName === 'A' && target.classList.contains('rest-response-id-link')) {
      event.preventDefault();
      const recordId = target.getAttribute('data-record-id');
      if (recordId) vscode.postMessage({ type: 'openRecord', recordId });
    }
  });

  headersToggleBtn.addEventListener('click', () => {
    headersOpen = !headersOpen;
    headersListEl.style.display = headersOpen ? '' : 'none';
  });

  /** @param {{ status: number, statusText?: string, headers: Record<string, string>, body: unknown }} data */
  function showResponse(data) {
    errorEl.style.display = 'none';
    const suffix = statusSuffix(data.status);
    metaEl.classList.remove(...STATUS_CLASSES);
    metaEl.classList.add(`rest-response-status--${suffix}`);
    metaEl.textContent = `${data.status}${data.statusText ? ' ' + data.statusText : ''}`;
    bodyEl.classList.remove(...BODY_BORDER_CLASSES);
    bodyEl.classList.add(`rest-response-body--${suffix}`);
    bodyEl.innerHTML =
      data.body === undefined || data.body === '' ? '(empty response)' : formatBodyHtml(data.body);
    renderHeadersList(data.headers);
    headersOpen = false;
    headersListEl.style.display = 'none';
    responseEl.style.display = '';
  }

  /** @param {string} message */
  function showError(message) {
    responseEl.style.display = 'none';
    errorEl.textContent = message;
    errorEl.style.display = '';
  }

  function hideResponse() {
    responseEl.style.display = 'none';
    errorEl.style.display = 'none';
    metaEl.classList.remove(...STATUS_CLASSES);
    bodyEl.classList.remove(...BODY_BORDER_CLASSES);
  }

  return { showResponse, showError, hideResponse };
}

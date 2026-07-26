// @ts-check
// Renders a failed Quick Query into the #query-error box: the verbatim Salesforce
// message first (its caret line and column marker are the point), then any
// diagnostics the host worked out — most usefully "this field exists, field-level
// security is hiding it", which the raw SF message reports as a missing column.

/**
 * @typedef {Object} SoqlDiagnostic
 * @property {'warning' | 'info'} severity
 * @property {string} title
 * @property {string} detail
 * @property {string[]} [suggestions]
 */

const SEVERITY_ICON = { warning: '🔒', info: 'ℹ️' };

/**
 * @param {{ errorEl: HTMLElement }} ctx
 */
export function createQueryErrorView(ctx) {
  const { errorEl } = ctx;

  /** @param {SoqlDiagnostic} diagnostic */
  function buildDiagnostic(diagnostic) {
    const box = document.createElement('div');
    box.className = `query-diag query-diag--${diagnostic.severity === 'warning' ? 'warning' : 'info'}`;

    const title = document.createElement('div');
    title.className = 'query-diag-title';
    title.textContent = `${SEVERITY_ICON[diagnostic.severity] || SEVERITY_ICON.info} ${diagnostic.title}`;
    box.appendChild(title);

    const detail = document.createElement('div');
    detail.className = 'query-diag-detail';
    detail.textContent = diagnostic.detail;
    box.appendChild(detail);

    if (diagnostic.suggestions && diagnostic.suggestions.length > 0) {
      const list = document.createElement('div');
      list.className = 'query-diag-suggestions';

      const label = document.createElement('span');
      label.className = 'query-diag-suggestions-label';
      label.textContent = 'Did you mean:';
      list.appendChild(label);

      for (const name of diagnostic.suggestions) {
        const chip = document.createElement('code');
        chip.className = 'query-diag-suggestion';
        chip.textContent = name;
        list.appendChild(chip);
      }
      box.appendChild(list);
    }

    return box;
  }

  /**
   * @param {string} message  The verbatim Salesforce error — never reworded.
   * @param {SoqlDiagnostic[]} [diagnostics]
   */
  function show(message, diagnostics) {
    errorEl.innerHTML = '';

    const raw = document.createElement('div');
    raw.className = 'query-error-raw';
    raw.textContent = message;
    errorEl.appendChild(raw);

    if (Array.isArray(diagnostics) && diagnostics.length > 0) {
      const separator = document.createElement('div');
      separator.className = 'query-error-sep';
      errorEl.appendChild(separator);
      for (const diagnostic of diagnostics) errorEl.appendChild(buildDiagnostic(diagnostic));
    }

    errorEl.style.display = '';
  }

  function hide() {
    errorEl.style.display = 'none';
    errorEl.innerHTML = '';
  }

  return { show, hide };
}

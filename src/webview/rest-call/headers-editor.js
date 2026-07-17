// @ts-check
// Key/value custom-headers editor for the REST tab. Dynamic add/remove rows,
// mirrors the row-management pattern of yaml-scripts' form-inputs-editor.js.

/**
 * @typedef {{ key: string, value: string }} HeaderEntry
 */

/**
 * @param {{ listEl: HTMLElement, addBtn: HTMLButtonElement, onChange?: () => void }} opts
 */
export function createHeadersEditor({ listEl, addBtn, onChange }) {
  /** @type {HeaderEntry[]} */
  let headers = [];

  function notifyChange() {
    if (onChange) onChange();
  }

  function render() {
    listEl.innerHTML = '';
    headers.forEach((header, idx) => {
      const row = document.createElement('div');
      row.className = 'rest-header-row';

      const keyInput = document.createElement('input');
      keyInput.type = 'text';
      keyInput.className = 'text-input rest-header-key';
      keyInput.placeholder = 'Header name';
      keyInput.value = header.key;
      keyInput.addEventListener('input', () => {
        headers[idx].key = keyInput.value;
        notifyChange();
      });

      const valueInput = document.createElement('input');
      valueInput.type = 'text';
      valueInput.className = 'text-input rest-header-value';
      valueInput.placeholder = 'Value';
      valueInput.value = header.value;
      valueInput.addEventListener('input', () => {
        headers[idx].value = valueInput.value;
        notifyChange();
      });

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'btn rest-header-remove-btn';
      removeBtn.textContent = '×';
      removeBtn.setAttribute('aria-label', 'Remove header');
      removeBtn.addEventListener('click', () => {
        headers.splice(idx, 1);
        render();
        notifyChange();
      });

      row.appendChild(keyInput);
      row.appendChild(valueInput);
      row.appendChild(removeBtn);
      listEl.appendChild(row);
    });
  }

  addBtn.addEventListener('click', () => {
    headers.push({ key: '', value: '' });
    render();
    const lastKeyInput = /** @type {HTMLInputElement | null} */ (
      listEl.querySelector('.rest-header-row:last-of-type .rest-header-key')
    );
    if (lastKeyInput) lastKeyInput.focus();
  });

  return {
    /** @returns {HeaderEntry[]} Non-blank rows only. */
    getHeaders: () => headers.filter((h) => h.key.trim()),
    /** @param {HeaderEntry[]} next */
    setHeaders: (next) => {
      headers = Array.isArray(next) ? next.map((h) => ({ key: h.key, value: h.value })) : [];
      render();
    },
  };
}

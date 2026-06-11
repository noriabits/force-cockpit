// @ts-check
/**
 * Shared folder/category combobox: a text input + ▾ toggle button + an
 * absolutely-positioned dropdown of existing folders. Free-text is always
 * allowed — the dropdown only *suggests* existing folders. CSS class names stay
 * per-feature via `optionClass` / `classPrefix` so there is no CSS churn.
 *
 * `createFolderCombobox` wires pre-existing DOM nodes (yaml-scripts' static
 * combobox in view.html). `buildFolderCombobox` first creates the wrapper /
 * input / toggle / dropdown nodes (monitoring builds its edit form dynamically)
 * and then delegates to `createFolderCombobox`.
 *
 * Both return a `cleanup()` that removes the document-level click-outside
 * listener — call it when the host form is torn down (monitoring's edit form
 * does; yaml-scripts' static combobox lives for the page lifetime and can
 * ignore it, but gains the leak-free contract for free).
 */

/**
 * @param {{
 *   wrapper: HTMLElement,
 *   input: HTMLInputElement,
 *   toggleBtn: HTMLElement,
 *   dropdownEl: HTMLElement,
 *   optionClass: string,
 *   getFolders: () => string[],
 *   onSelect?: (folder: string) => void,
 * }} opts
 * @returns {{ refresh: () => void, open: () => void, close: () => void, cleanup: () => void }}
 */
export function createFolderCombobox(opts) {
  const { wrapper, input, toggleBtn, dropdownEl, optionClass, getFolders, onSelect } = opts;

  function refresh() {
    const folders = [...new Set(getFolders())].sort();
    dropdownEl.innerHTML = '';
    for (const folder of folders) {
      const opt = document.createElement('div');
      opt.className = optionClass;
      opt.textContent = folder;
      // mousedown (not click) + preventDefault so the value is set before the
      // input's blur would otherwise close the dropdown.
      opt.addEventListener('mousedown', (e) => {
        e.preventDefault();
        input.value = folder;
        dropdownEl.classList.remove('open');
        if (onSelect) onSelect(folder);
      });
      dropdownEl.appendChild(opt);
    }
  }

  function open() {
    if (dropdownEl.children.length > 0) dropdownEl.classList.add('open');
  }

  function close() {
    dropdownEl.classList.remove('open');
  }

  toggleBtn.addEventListener('click', () => {
    if (dropdownEl.classList.contains('open')) close();
    else open();
    input.focus();
  });

  const clickHandler = (/** @type {MouseEvent} */ e) => {
    if (!wrapper.contains(/** @type {Node} */ (e.target))) close();
  };
  document.addEventListener('click', clickHandler);

  return {
    refresh,
    open,
    close,
    cleanup: () => document.removeEventListener('click', clickHandler),
  };
}

/**
 * Create the combobox DOM (wrapper + input + toggle + dropdown) and wire it.
 * Used by monitoring, whose edit form is built dynamically.
 * @param {{
 *   classPrefix: string,
 *   value?: string,
 *   placeholder?: string,
 *   inputId?: string,
 *   getFolders: () => string[],
 *   onSelect?: (folder: string) => void,
 * }} opts
 * @returns {{ element: HTMLDivElement, input: HTMLInputElement, refresh: () => void, open: () => void, close: () => void, cleanup: () => void }}
 */
export function buildFolderCombobox(opts) {
  const { classPrefix, value = '', placeholder = '', inputId, getFolders, onSelect } = opts;

  const wrapper = document.createElement('div');
  wrapper.className = `${classPrefix}-combobox`;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'text-input';
  input.value = value;
  input.placeholder = placeholder;
  if (inputId) input.id = inputId;
  input.autocomplete = 'off';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = `${classPrefix}-toggle`;
  toggle.tabIndex = -1;
  toggle.innerHTML = '&#9662;';

  const dropdown = document.createElement('div');
  dropdown.className = `${classPrefix}-dropdown`;

  wrapper.appendChild(input);
  wrapper.appendChild(toggle);
  wrapper.appendChild(dropdown);

  const api = createFolderCombobox({
    wrapper,
    input,
    toggleBtn: toggle,
    dropdownEl: dropdown,
    optionClass: `${classPrefix}-option`,
    getFolders,
    onSelect,
  });
  api.refresh();

  return { element: wrapper, input, ...api };
}

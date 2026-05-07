// @ts-check
// Editor for the dynamic `inputs:` section of a YAML script form. Owns its own
// state array and renders into a list element. Exposes get/set/clear.

/**
 * @typedef {{
 *   name: string,
 *   label: string,
 *   type: 'string' | 'picklist' | 'checkbox' | 'textarea',
 *   required: boolean,
 *   options: string,
 *   checkboxDefault: boolean,
 * }} FormInput
 */

/**
 * @param {FormInput} input
 * @param {number} idx
 * @param {FormInput[]} inputs
 * @param {any} labels
 * @returns {{ nameInput: HTMLInputElement, labelInput: HTMLInputElement, typeSelect: HTMLSelectElement, reqLabel: HTMLLabelElement, removeBtn: HTMLButtonElement }}
 */
function buildSharedInputHeader(input, idx, inputs, labels, onChanged) {
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'text-input yaml-input-name';
  nameInput.placeholder = labels.placeholderInputName;
  nameInput.value = input.name;
  nameInput.addEventListener('input', () => {
    inputs[idx].name = nameInput.value;
  });

  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.className = 'text-input yaml-input-label';
  labelInput.placeholder = labels.placeholderInputLabel;
  labelInput.value = input.label;
  labelInput.addEventListener('input', () => {
    inputs[idx].label = labelInput.value;
  });

  const typeSelect = document.createElement('select');
  typeSelect.className = 'text-input yaml-input-type-select';
  const optString = document.createElement('option');
  optString.value = 'string';
  optString.textContent = labels.typeString;
  const optPicklist = document.createElement('option');
  optPicklist.value = 'picklist';
  optPicklist.textContent = labels.typePicklist;
  const optCheckbox = document.createElement('option');
  optCheckbox.value = 'checkbox';
  optCheckbox.textContent = labels.typeCheckbox;
  const optTextarea = document.createElement('option');
  optTextarea.value = 'textarea';
  optTextarea.textContent = labels.typeTextarea;
  typeSelect.appendChild(optString);
  typeSelect.appendChild(optPicklist);
  typeSelect.appendChild(optCheckbox);
  typeSelect.appendChild(optTextarea);
  typeSelect.value = input.type;

  const reqLabel = document.createElement('label');
  reqLabel.className = 'yaml-input-required-label';
  const reqCheckbox = document.createElement('input');
  reqCheckbox.type = 'checkbox';
  reqCheckbox.checked = input.required;
  reqCheckbox.addEventListener('change', () => {
    inputs[idx].required = reqCheckbox.checked;
  });
  reqLabel.appendChild(reqCheckbox);
  reqLabel.appendChild(document.createTextNode(labels.labelRequired));

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn yaml-input-remove-btn';
  removeBtn.textContent = labels.btnRemoveInput;
  removeBtn.addEventListener('click', () => {
    inputs.splice(idx, 1);
    onChanged();
  });

  return { nameInput, labelInput, typeSelect, reqLabel, removeBtn };
}

/**
 * @param {FormInput} input
 * @param {number} idx
 * @param {FormInput[]} inputs
 * @param {any} labels
 * @returns {HTMLElement}
 */
function buildPicklistSubRow(input, idx, inputs, labels) {
  const optionsRow = document.createElement('div');
  optionsRow.className = 'yaml-input-options-row';
  const optionsInput = document.createElement('input');
  optionsInput.type = 'text';
  optionsInput.className = 'text-input';
  optionsInput.placeholder = labels.placeholderOptions;
  optionsInput.value = input.options;
  optionsInput.addEventListener('input', () => {
    inputs[idx].options = optionsInput.value;
  });
  optionsRow.appendChild(optionsInput);
  optionsRow.style.display = input.type === 'picklist' ? '' : 'none';
  return optionsRow;
}

/**
 * @param {FormInput} input
 * @param {number} idx
 * @param {FormInput[]} inputs
 * @param {any} labels
 * @returns {HTMLElement}
 */
function buildCheckboxSubRow(input, idx, inputs, labels) {
  const defaultRow = document.createElement('div');
  defaultRow.className = 'yaml-input-options-row yaml-input-default-row';
  const defaultLabel = document.createElement('label');
  defaultLabel.className = 'yaml-input-required-label';
  const defaultCheckbox = document.createElement('input');
  defaultCheckbox.type = 'checkbox';
  defaultCheckbox.checked = input.checkboxDefault;
  defaultCheckbox.addEventListener('change', () => {
    inputs[idx].checkboxDefault = defaultCheckbox.checked;
  });
  defaultLabel.appendChild(defaultCheckbox);
  defaultLabel.appendChild(document.createTextNode(labels.labelCheckboxDefault));
  defaultRow.appendChild(defaultLabel);
  defaultRow.style.display = input.type === 'checkbox' ? '' : 'none';
  return defaultRow;
}

/**
 * @param {{ listEl: HTMLElement, addBtn: HTMLButtonElement, labels: any }} opts
 */
export function createFormInputsEditor({ listEl, addBtn, labels }) {
  /** @type {FormInput[]} */
  let formInputs = [];

  function render() {
    listEl.innerHTML = '';
    formInputs.forEach((input, idx) => {
      const { nameInput, labelInput, typeSelect, reqLabel, removeBtn } = buildSharedInputHeader(
        input,
        idx,
        formInputs,
        labels,
        render,
      );
      const optionsRow = buildPicklistSubRow(input, idx, formInputs, labels);
      const defaultRow = buildCheckboxSubRow(input, idx, formInputs, labels);

      const row = document.createElement('div');
      row.className = 'yaml-input-row';
      row.appendChild(nameInput);
      row.appendChild(labelInput);
      row.appendChild(typeSelect);
      row.appendChild(reqLabel);
      row.appendChild(removeBtn);
      listEl.appendChild(row);
      listEl.appendChild(optionsRow);
      listEl.appendChild(defaultRow);

      typeSelect.addEventListener('change', () => {
        formInputs[idx].type = /** @type {FormInput['type']} */ (typeSelect.value);
        optionsRow.style.display = typeSelect.value === 'picklist' ? '' : 'none';
        defaultRow.style.display = typeSelect.value === 'checkbox' ? '' : 'none';
      });
    });
  }

  addBtn.addEventListener('click', () => {
    formInputs.push({
      name: '',
      label: '',
      type: 'string',
      required: false,
      options: '',
      checkboxDefault: false,
    });
    render();
    const lastNameInput = /** @type {HTMLInputElement | null} */ (
      listEl.querySelector('.yaml-input-row:last-of-type .yaml-input-name')
    );
    if (lastNameInput) lastNameInput.focus();
  });

  return {
    /** @returns {FormInput[]} */
    getInputs: () => formInputs,
    /** @param {FormInput[]} next */
    setInputs: (next) => {
      formInputs = next;
      render();
    },
    clear: () => {
      formInputs = [];
      render();
    },
  };
}

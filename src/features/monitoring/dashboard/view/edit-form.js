// @ts-check
// The monitoring card edit form: name/category/SOQL/value-field rows, the
// folder combobox, chart-type-dependent field visibility, the 800ms preview
// debounce, and save/cancel/delete wiring. Receives everything it needs via
// ctx so it never reaches into the orchestrator's scope. The `card.__pending*`
// hooks it sets are invoked by the message handlers in index.js — that contract
// is preserved here.
import { ALL_CHART_TYPES } from './chart-rendering';
import { buildFolderCombobox } from '../../../shared/view/folder-combobox.js';

/**
 * @typedef {Object} EditFormCtx
 * @property {any} labels
 * @property {{ postMessage: (msg: any) => void }} vscode
 * @property {Map<string, any>} chartInstances
 * @property {() => any[]} getConfigs
 * @property {() => number} nextAvailablePosition
 * @property {(cfg: any) => HTMLElement} buildViewCard
 * @property {(cfg: any) => void} triggerQuery
 */

/**
 * @param {EditFormCtx} ctx
 */
export function createEditForm(ctx) {
  const {
    labels: L,
    vscode,
    chartInstances,
    getConfigs,
    nextAvailablePosition,
    buildViewCard,
    triggerQuery,
  } = ctx;

  /** @type {Map<string, ReturnType<typeof setTimeout>>} preview-key → debounce timer */
  const debounceTimers = new Map();

  // ── Form helpers ─────────────────────────────────────────────────────────
  /**
   * @param {string} labelText
   * @param {HTMLElement} inputEl
   */
  function makeFormRow(labelText, inputEl) {
    const row = document.createElement('div');
    row.className = 'monitoring-form-row';
    const label = document.createElement('label');
    label.className = 'monitoring-form-label';
    label.textContent = labelText;
    row.appendChild(label);
    row.appendChild(inputEl);
    return row;
  }

  /**
   * @param {string} type
   * @param {string} value
   * @param {string} placeholder
   * @param {string} id
   * @returns {HTMLInputElement}
   */
  function makeInput(type, value, placeholder, id) {
    const input = document.createElement('input');
    input.type = type;
    input.className = 'text-input';
    input.value = value || '';
    input.placeholder = placeholder || '';
    if (id) input.id = id;
    return input;
  }

  /** @param {string} currentFormat @returns {HTMLSelectElement} */
  function buildFormatSelect(currentFormat) {
    const formatSelect = document.createElement('select');
    formatSelect.className = 'monitoring-vf-format-select';
    formatSelect.title = L.labelValueFieldFormat;
    for (const [val, lbl] of Object.entries(L.formatOptions)) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = /** @type {string} */ (lbl);
      if (val === (currentFormat || '')) opt.selected = true;
      formatSelect.appendChild(opt);
    }
    return formatSelect;
  }

  /**
   * @param {number | null} threshold
   * @param {string} thresholdCondition
   * @returns {{ thresholdInput: HTMLInputElement, conditionSelect: HTMLSelectElement }}
   */
  function buildThresholdGroup(threshold, thresholdCondition) {
    const thresholdInput = /** @type {HTMLInputElement} */ (
      makeInput('number', threshold != null ? String(threshold) : '', L.placeholderThreshold, '')
    );
    thresholdInput.className = 'text-input monitoring-vf-threshold-input';
    thresholdInput.title = L.placeholderThreshold;
    thresholdInput.min = '0';

    const conditionSelect = document.createElement('select');
    conditionSelect.className = 'monitoring-vf-condition-select';
    conditionSelect.title = L.labelThresholdCondition;
    for (const [val, lbl] of Object.entries(L.conditionOptions)) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = /** @type {string} */ (lbl);
      if (val === (thresholdCondition || 'above')) opt.selected = true;
      conditionSelect.appendChild(opt);
    }

    return { thresholdInput, conditionSelect };
  }

  /**
   * @param {string} field
   * @param {string} label
   * @param {string} format
   * @param {number | null} threshold
   * @param {string} thresholdCondition
   * @param {HTMLElement} container
   */
  function makeValueFieldRow(field, label, format, threshold, thresholdCondition, container) {
    const row = document.createElement('div');
    row.className = 'monitoring-value-field-row';

    const fieldInput = makeInput('text', field, L.placeholderValueFieldApi, '');
    fieldInput.title = L.labelValueFieldApi;

    const labelInput = makeInput('text', label, L.placeholderValueFieldLabel, '');
    labelInput.title = L.labelValueFieldLabel;

    const { thresholdInput, conditionSelect } = buildThresholdGroup(threshold, thresholdCondition);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'monitoring-remove-vf-btn';
    removeBtn.textContent = L.btnRemoveValueField;
    removeBtn.title = 'Remove';
    removeBtn.addEventListener('click', () => {
      // Keep at least one row
      const rows = container.querySelectorAll('.monitoring-value-field-row');
      if (rows.length > 1) row.remove();
    });

    row.appendChild(fieldInput);
    row.appendChild(labelInput);
    row.appendChild(buildFormatSelect(format));
    row.appendChild(thresholdInput);
    row.appendChild(conditionSelect);
    row.appendChild(removeBtn);
    return row;
  }

  // ── Build edit form ──────────────────────────────────────────────────────
  /**
   * @param {any} cfg
   * @param {any} card
   * @param {string | null} configId
   */
  function buildEditForm(cfg, card, configId) {
    const form = document.createElement('div');
    form.className = 'monitoring-edit-form';
    /** @type {Array<() => void>} */
    const cleanups = []; // Track cleanup functions for form teardown

    // Name
    form.appendChild(
      makeFormRow(
        L.labelName,
        makeInput('text', cfg.name, L.placeholderName, 'monitoring-edit-name'),
      ),
    );

    // Category
    const folderCombo = buildFolderCombobox({
      classPrefix: 'monitoring-folder',
      value: cfg.folder,
      placeholder: L.placeholderCategory,
      inputId: 'monitoring-edit-folder',
      getFolders: () => getConfigs().map((/** @type {any} */ c) => c.folder),
    });
    cleanups.push(folderCombo.cleanup);
    form.appendChild(makeFormRow(L.labelCategory, folderCombo.element));

    // Description
    form.appendChild(
      makeFormRow(
        L.labelDescription,
        makeInput('text', cfg.description, L.placeholderDescription, 'monitoring-edit-desc'),
      ),
    );

    // SOQL
    const soqlArea = document.createElement('textarea');
    soqlArea.className = 'text-input monitoring-soql-input';
    soqlArea.value = cfg.soql;
    soqlArea.placeholder = L.placeholderSoql;
    soqlArea.id = 'monitoring-edit-soql';
    form.appendChild(makeFormRow(L.labelSoql, soqlArea));

    // Label field (hidden for metric type)
    const labelFieldInput = makeInput(
      'text',
      cfg.labelField,
      L.placeholderLabelField,
      'monitoring-edit-labelfield',
    );
    const labelFieldRow = makeFormRow(L.labelLabelField, labelFieldInput);
    form.appendChild(labelFieldRow);

    // Value fields
    const vfContainer = document.createElement('div');
    vfContainer.className = 'monitoring-value-fields';
    for (const vf of cfg.valueFields) {
      vfContainer.appendChild(
        makeValueFieldRow(
          vf.field,
          vf.label,
          vf.format || '',
          vf.threshold ?? null,
          vf.thresholdCondition || 'above',
          vfContainer,
        ),
      );
    }
    const addVfBtn = document.createElement('button');
    addVfBtn.className = 'btn btn-secondary btn-sm';
    addVfBtn.textContent = L.btnAddValueField;
    addVfBtn.style.alignSelf = 'flex-start';
    addVfBtn.addEventListener('click', () => {
      vfContainer.insertBefore(makeValueFieldRow('', '', '', null, 'above', vfContainer), addVfBtn);
    });
    vfContainer.appendChild(addVfBtn);
    form.appendChild(makeFormRow(L.labelValueFields, vfContainer));

    // Chart type
    const chartTypeSelect = document.createElement('select');
    chartTypeSelect.className = 'text-input monitoring-chart-type-select';
    chartTypeSelect.style.width = 'auto';
    for (const t of ALL_CHART_TYPES) {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = L.chartTypes[t];
      if (t === cfg.chartType) opt.selected = true;
      chartTypeSelect.appendChild(opt);
    }
    form.appendChild(makeFormRow(L.labelChartType, chartTypeSelect));

    // Stacked checkbox (bar/line only)
    const stackedCheckbox = document.createElement('input');
    stackedCheckbox.type = 'checkbox';
    stackedCheckbox.id = 'monitoring-edit-stacked';
    stackedCheckbox.checked = cfg.stacked || false;
    const stackedRow = makeFormRow(L.labelStacked, stackedCheckbox);
    stackedRow.classList.add('monitoring-form-row--inline');
    form.appendChild(stackedRow);

    // Notify on record count increase — applies to all chart types
    const notifyCheckbox = document.createElement('input');
    notifyCheckbox.type = 'checkbox';
    notifyCheckbox.id = 'monitoring-edit-notify-increase';
    notifyCheckbox.checked = cfg.notifyOnIncrease || false;
    const notifyRow = makeFormRow(L.labelNotifyOnIncrease, notifyCheckbox);
    notifyRow.classList.add('monitoring-form-row--inline');
    form.appendChild(notifyRow);

    // Refresh interval
    const intervalInput = makeInput(
      'number',
      String(cfg.refreshInterval ?? 0),
      '0',
      'monitoring-edit-interval',
    );
    intervalInput.min = '0';
    intervalInput.style.width = '80px';
    form.appendChild(makeFormRow(L.labelRefreshInterval, intervalInput));

    // Private checkbox
    const privateCheckbox = document.createElement('input');
    privateCheckbox.type = 'checkbox';
    privateCheckbox.id = 'monitoring-edit-private';
    privateCheckbox.checked = cfg.source === 'private';
    const privateRow = makeFormRow(L.labelPrivate, privateCheckbox);
    privateRow.classList.add('monitoring-form-row--inline');
    form.appendChild(privateRow);

    // Preview area — contains canvas, table placeholder, and metric placeholder
    const previewWrapper = document.createElement('div');
    previewWrapper.className = 'monitoring-preview-wrapper monitoring-canvas-wrapper';

    const previewCanvasId = 'chart-preview-' + (configId || 'new').replace(/\//g, '-');
    const previewCanvas = document.createElement('canvas');
    previewCanvas.id = previewCanvasId;
    previewCanvas.className = 'monitoring-preview-canvas';
    previewWrapper.appendChild(previewCanvas);

    const previewTableWrapper = document.createElement('div');
    previewTableWrapper.className = 'monitoring-table-wrapper monitoring-preview-table';
    previewTableWrapper.style.display = 'none';
    previewWrapper.appendChild(previewTableWrapper);

    const previewMetricEl = document.createElement('div');
    previewMetricEl.className = 'monitoring-metric-display monitoring-preview-metric';
    previewMetricEl.style.display = 'none';
    previewWrapper.appendChild(previewMetricEl);

    form.appendChild(previewWrapper);

    // Status / error
    const statusEl = document.createElement('span');
    statusEl.className = 'monitoring-status';
    form.appendChild(statusEl);

    const errorBox = document.createElement('div');
    errorBox.className = 'error-box';
    errorBox.style.display = 'none';
    form.appendChild(errorBox);

    // Actions row
    const actionsRow = document.createElement('div');
    actionsRow.className = 'monitoring-edit-actions';

    const previewBtn = document.createElement('button');
    previewBtn.className = 'btn btn-secondary';
    previewBtn.textContent = L.btnPreview;

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-primary';
    saveBtn.textContent = L.btnSave;

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-secondary';
    cancelBtn.textContent = L.btnCancel;

    actionsRow.appendChild(previewBtn);
    actionsRow.appendChild(saveBtn);
    actionsRow.appendChild(cancelBtn);

    // Delete button — only when editing an existing config
    if (configId) {
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn monitoring-form-delete-btn';
      deleteBtn.textContent = L.btnDelete;
      deleteBtn.addEventListener('click', () => {
        vscode.postMessage({
          type: 'deleteMonitoringConfig',
          configId,
          configName: cfg.name,
          source: cfg.source,
          isPrivate: cfg.source === 'private',
        });
      });
      actionsRow.appendChild(deleteBtn);
    }

    form.appendChild(actionsRow);

    // ── Visibility helpers ──
    function updateFormVisibility() {
      const type = chartTypeSelect.value;
      // Hide label field for metric (not needed)
      labelFieldRow.style.display = type === 'metric' ? 'none' : '';
      // Show stacked only for bar / line
      stackedRow.style.display = type === 'bar' || type === 'line' ? '' : 'none';
    }

    updateFormVisibility();
    chartTypeSelect.addEventListener('change', updateFormVisibility);

    // ── Helpers used by event handlers ──
    function readScalarFormFields() {
      const nameVal = /** @type {HTMLInputElement} */ (
        form.querySelector('#monitoring-edit-name')
      ).value.trim();
      const folderVal =
        /** @type {HTMLInputElement} */ (
          form.querySelector('#monitoring-edit-folder')
        ).value.trim() || 'general';
      const descVal = /** @type {HTMLInputElement} */ (
        form.querySelector('#monitoring-edit-desc')
      ).value.trim();
      const soqlVal = /** @type {HTMLTextAreaElement} */ (
        form.querySelector('#monitoring-edit-soql')
      ).value.trim();
      const labelFieldVal = /** @type {HTMLInputElement} */ (
        form.querySelector('#monitoring-edit-labelfield')
      ).value.trim();
      const intervalVal =
        parseInt(
          /** @type {HTMLInputElement} */ (form.querySelector('#monitoring-edit-interval')).value,
          10,
        ) || 0;
      const stackedVal =
        /** @type {HTMLInputElement} */ (form.querySelector('#monitoring-edit-stacked'))?.checked ||
        false;
      const notifyOnIncreaseVal =
        /** @type {HTMLInputElement} */ (form.querySelector('#monitoring-edit-notify-increase'))
          ?.checked || false;
      return {
        nameVal,
        folderVal,
        descVal,
        soqlVal,
        labelFieldVal,
        intervalVal,
        stackedVal,
        notifyOnIncreaseVal,
      };
    }

    function readValueFields() {
      const vfRows = vfContainer.querySelectorAll('.monitoring-value-field-row');
      const valueFields = [];
      for (const row of vfRows) {
        const inputs = row.querySelectorAll('input');
        const formatSel = /** @type {HTMLSelectElement | null} */ (
          row.querySelector('.monitoring-vf-format-select')
        );
        const conditionSel = /** @type {HTMLSelectElement | null} */ (
          row.querySelector('.monitoring-vf-condition-select')
        );
        const field = inputs[0].value.trim();
        const label = inputs[1].value.trim();
        const format = formatSel ? formatSel.value : '';
        const thresholdRaw = inputs[2] ? inputs[2].value.trim() : '';
        const threshold = thresholdRaw !== '' ? Number(thresholdRaw) : undefined;
        const thresholdCondition = conditionSel ? conditionSel.value : 'above';
        if (field) {
          /** @type {any} */
          const vf = { field, label: label || field };
          if (format) vf.format = format;
          if (threshold != null && !isNaN(threshold)) {
            vf.threshold = threshold;
            vf.thresholdCondition = thresholdCondition;
          }
          valueFields.push(vf);
        }
      }
      return valueFields;
    }

    function readFormConfig() {
      const {
        nameVal,
        folderVal,
        descVal,
        soqlVal,
        labelFieldVal,
        intervalVal,
        stackedVal,
        notifyOnIncreaseVal,
      } = readScalarFormFields();
      const valueFields = readValueFields();
      const position = configId ? cfg.position : nextAvailablePosition();
      return {
        id: configId || '',
        // Previous location — lets the host delete the old file when the
        // category or name changes (move semantics)
        source: cfg.source,
        folder: folderVal,
        name: nameVal,
        description: descVal,
        soql: soqlVal,
        labelField: labelFieldVal,
        valueFields: valueFields.length > 0 ? valueFields : cfg.valueFields,
        chartType: chartTypeSelect.value,
        refreshInterval: intervalVal,
        stacked: stackedVal,
        notifyOnIncrease: notifyOnIncreaseVal,
        ...(typeof position === 'number' ? { position } : {}),
      };
    }

    function triggerPreview() {
      const liveCfg = readFormConfig();
      const isMetric = liveCfg.chartType === 'metric';
      const isTable = liveCfg.chartType === 'table';

      if (!liveCfg.soql || liveCfg.valueFields.length === 0) return;
      if (!isMetric && !liveCfg.labelField) return;

      statusEl.textContent = L.statusLoading;
      errorBox.style.display = 'none';

      const previewId = '__preview__' + (configId || 'new');

      if (isTable) {
        vscode.postMessage({
          type: 'runMonitoringTableQuery',
          configId: previewId,
          configName: liveCfg.name,
          soql: liveCfg.soql,
          labelField: liveCfg.labelField,
          valueFields: liveCfg.valueFields,
        });
      } else {
        vscode.postMessage({
          type: 'runMonitoringQuery',
          configId: previewId,
          configName: liveCfg.name,
          soql: liveCfg.soql,
          labelField: liveCfg.labelField,
          valueFields: liveCfg.valueFields,
        });
      }
    }

    // Debounced auto-preview on SOQL change
    soqlArea.addEventListener('input', () => {
      const timerId = debounceTimers.get('__preview__');
      if (timerId) clearTimeout(timerId);
      debounceTimers.set('__preview__', setTimeout(triggerPreview, 800));
    });

    // Chart type change → instant update on preview chart (canvas types only)
    chartTypeSelect.addEventListener('change', () => {
      const previewId = '__preview__' + (configId || 'new');
      const chart = chartInstances.get(previewId);
      if (chart) {
        chart.config.type = chartTypeSelect.value;
        chart.update();
      }
    });

    previewBtn.addEventListener('click', triggerPreview);

    saveBtn.addEventListener('click', () => {
      const liveCfg = readFormConfig();
      if (!liveCfg.name) {
        errorBox.textContent = 'Name is required.';
        errorBox.style.display = '';
        return;
      }
      if (!liveCfg.soql) {
        errorBox.textContent = 'SOQL query is required.';
        errorBox.style.display = '';
        return;
      }
      if (!liveCfg.labelField && liveCfg.chartType !== 'metric') {
        errorBox.textContent = 'Label field is required.';
        errorBox.style.display = '';
        return;
      }
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
      card.__pendingSaveError = (/** @type {string} */ errMsg) => {
        saveBtn.disabled = false;
        saveBtn.textContent = L.btnSave;
        errorBox.textContent = errMsg;
        errorBox.style.display = '';
      };
      // On success the host route persists the file and the webview reloads the
      // whole grid from disk (see onSaveResult), so the rebuilt card always
      // carries the persisted id. We only stash the form cleanups here so that
      // reload-time teardown can release this form's listeners/timers.
      card.__pendingSaveResolveCleanups = /** @type {Array<() => void>} */ (cleanups);
      const isPrivate =
        /** @type {HTMLInputElement | null} */ (form.querySelector('#monitoring-edit-private'))
          ?.checked || false;
      vscode.postMessage({ type: 'saveMonitoringConfig', config: liveCfg, isPrivate });
    });

    cancelBtn.addEventListener('click', () => {
      cleanups.forEach((/** @type {() => void} */ cleanup) => cleanup());
      if (configId) {
        // Revert to view mode with original config. buildViewCard only builds an
        // empty canvas/table/metric shell — the chart instance was destroyed on
        // entering edit mode — so re-run the query to repopulate it (otherwise the
        // card stays blank until the user clicks Refresh).
        const originalCfg = getConfigs().find((/** @type {any} */ c) => c.id === configId) || cfg;
        const newCard = buildViewCard(originalCfg);
        card.replaceWith(newCard);
        triggerQuery(originalCfg);
      } else {
        // New card — just remove it
        card.remove();
      }
    });

    return form;
  }

  return { buildEditForm };
}

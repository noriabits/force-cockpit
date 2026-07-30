// @ts-check
// The trace-flag manager: pick what to trace (me / Automated Process / any user
// / an Apex class), pick a debug level (preset, custom, or an existing
// DebugLevel), pick a duration, and manage the flags that are already running.
import { DURATION_OPTIONS, formatCountdown } from './format';

const CATEGORIES = [
  'ApexCode',
  'ApexProfiling',
  'Callout',
  'Database',
  'System',
  'Validation',
  'Visualforce',
  'Workflow',
];
const LEVELS = ['NONE', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'FINE', 'FINER', 'FINEST'];

/**
 * @param {{
 *   labels: any,
 *   vscode: { postMessage: (msg: any) => void },
 *   escapeHtml: (s: string) => string,
 *   getOrgData: () => any,
 *   onStateChange: (patch: any) => void,
 * }} ctx
 */
export function createTraceFlagPanel(ctx) {
  const { labels, vscode, escapeHtml } = ctx;
  const $ = (/** @type {string} */ id) => document.getElementById(id);

  const segEl = /** @type {HTMLElement} */ ($('dbg-entity-seg'));
  const hintEl = /** @type {HTMLElement} */ ($('dbg-entity-hint'));
  const searchRow = /** @type {HTMLElement} */ ($('dbg-entity-search-row'));
  const searchInput = /** @type {HTMLInputElement} */ ($('dbg-entity-search'));
  const resultsEl = /** @type {HTMLElement} */ ($('dbg-entity-results'));
  const selectedEl = /** @type {HTMLElement} */ ($('dbg-selected-entity'));
  const presetSel = /** @type {HTMLSelectElement} */ ($('dbg-preset'));
  const presetHint = /** @type {HTMLElement} */ ($('dbg-preset-hint'));
  const customToggle = /** @type {HTMLButtonElement} */ ($('dbg-custom-toggle'));
  const customEl = /** @type {HTMLElement} */ ($('dbg-custom-levels'));
  const durationSel = /** @type {HTMLSelectElement} */ ($('dbg-duration'));
  const startBtn = /** @type {HTMLButtonElement} */ ($('dbg-start-trace'));
  const flagsEl = /** @type {HTMLElement} */ ($('dbg-flags'));
  const statusEl = /** @type {HTMLElement} */ ($('dbg-trace-status'));
  const errorEl = /** @type {HTMLElement} */ ($('dbg-trace-error'));

  /** @type {any[]} */ let presets = [];
  /** @type {any[]} */ let systemUsers = [];
  /** @type {any} */ let currentUser = null;
  /** @type {any[]} */ let traceFlags = [];
  /** @type {any} */ let selectedEntity = null;
  /** @type {'me'|'system'|'user'|'apex'} */ let mode = 'me';
  let customOpen = false;
  /** @type {any} */ let searchTimer = null;
  /** @type {any} */ let countdownTimer = null;

  // ── Debug level ─────────────────────────────────────────────────────────

  function renderPresets() {
    presetSel.innerHTML = '';
    for (const preset of presets) {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = preset.recommended
        ? `${preset.label} — ${labels.recommendedSuffix}`
        : preset.label;
      presetSel.appendChild(option);
    }
    updatePresetHint();
  }

  function selectedPreset() {
    return presets.find((p) => p.id === presetSel.value) ?? null;
  }

  /**
   * The hint under the picker is where a user who does not know the category
   * matrix learns what they are about to capture: when to use it, the longer
   * description, and the resulting levels.
   */
  function updatePresetHint() {
    const preset = selectedPreset();
    if (!preset) {
      presetHint.innerHTML = '';
      return;
    }
    const levels = CATEGORIES.filter((c) => preset.levels[c] !== 'NONE')
      .map((c) => `${c}=${preset.levels[c]}`)
      .join(', ');
    const warning = preset.truncationWarning
      ? `<div class="dbg-warning">${escapeHtml(labels.truncationWarning)}</div>`
      : '';
    presetHint.innerHTML =
      `<div class="dbg-hint-when"><strong>${escapeHtml(preset.whenToUse)}</strong></div>` +
      `<div class="dbg-hint-desc">${escapeHtml(preset.description)}</div>` +
      `<div class="dbg-hint-levels mono">${escapeHtml(levels)}</div>` +
      warning;
  }

  function renderCustomLevels() {
    const preset = selectedPreset();
    customEl.innerHTML = '';
    for (const category of CATEGORIES) {
      const row = document.createElement('label');
      row.className = 'dbg-custom-row';
      const name = document.createElement('span');
      name.textContent = category;
      const select = document.createElement('select');
      select.className = 'text-input dbg-select dbg-select--narrow';
      select.dataset.category = category;
      for (const level of LEVELS) {
        const option = document.createElement('option');
        option.value = level;
        option.textContent = level;
        select.appendChild(option);
      }
      select.value = preset ? preset.levels[category] : 'NONE';
      row.appendChild(name);
      row.appendChild(select);
      customEl.appendChild(row);
    }
  }

  /** Category levels from the custom editor, or null when it is closed. */
  function customLevels() {
    if (!customOpen) return null;
    /** @type {any} */ const levels = {};
    customEl.querySelectorAll('select[data-category]').forEach((el) => {
      const select = /** @type {HTMLSelectElement} */ (el);
      levels[String(select.dataset.category)] = select.value;
    });
    return levels;
  }

  // ── Entity picking ──────────────────────────────────────────────────────

  function setMode(/** @type {'me'|'system'|'user'|'apex'} */ next) {
    mode = next;
    segEl.querySelectorAll('.dbg-seg-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-entity') === next);
    });
    hintEl.textContent =
      next === 'me'
        ? labels.entityHintMe
        : next === 'system'
          ? labels.entityHintSystem
          : next === 'user'
            ? labels.entityHintUser
            : labels.entityHintApex;

    const needsSearch = next === 'user' || next === 'apex';
    searchRow.style.display = needsSearch ? '' : 'none';
    searchInput.placeholder =
      next === 'apex' ? labels.searchPlaceholderApex : labels.searchPlaceholderUser;
    searchInput.value = '';
    resultsEl.innerHTML = '';

    if (next === 'me') selectEntity(currentUser);
    else if (next === 'system') renderEntityList(systemUsers);
    else selectEntity(null);
  }

  function renderEntityList(/** @type {any[]} */ entities) {
    resultsEl.innerHTML = '';
    if (!entities.length) {
      resultsEl.innerHTML = `<div class="dbg-empty">${escapeHtml(labels.noEntities)}</div>`;
      return;
    }
    for (const entity of entities) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'dbg-entity-row';
      row.innerHTML =
        `<span class="dbg-entity-name">${escapeHtml(entity.name)}</span>` +
        `<span class="dbg-entity-sub">${escapeHtml(entity.subtitle)}</span>` +
        (entity.system ? '<span class="dbg-badge">system</span>' : '');
      row.addEventListener('click', () => {
        selectEntity(entity);
        resultsEl.innerHTML = '';
      });
      resultsEl.appendChild(row);
    }
  }

  function selectEntity(/** @type {any} */ entity) {
    selectedEntity = entity;
    if (!entity) {
      selectedEl.style.display = 'none';
      selectedEl.innerHTML = '';
      return;
    }
    selectedEl.style.display = '';
    const kindLabel =
      entity.kind === 'user' ? 'user' : entity.kind === 'apexClass' ? 'Apex class' : 'trigger';
    selectedEl.innerHTML =
      `<strong>${escapeHtml(entity.name)}</strong> ` +
      `<span class="dbg-entity-sub">${escapeHtml(entity.subtitle)} · ${kindLabel}</span>`;
  }

  // ── Active flags ────────────────────────────────────────────────────────

  function renderFlags() {
    flagsEl.innerHTML = '';
    if (!traceFlags.length) {
      flagsEl.innerHTML = `<div class="dbg-empty">${escapeHtml(labels.noActiveFlags)}</div>`;
      return;
    }
    for (const flag of traceFlags) {
      const row = document.createElement('div');
      row.className = 'dbg-flag-row';
      row.dataset.expires = flag.expirationDate;

      const info = document.createElement('div');
      info.className = 'dbg-flag-info';
      info.innerHTML =
        `<strong>${escapeHtml(flag.entityName)}</strong> ` +
        `<span class="dbg-badge">${escapeHtml(flag.logType)}</span> ` +
        `<span class="dbg-entity-sub">${escapeHtml(flag.debugLevelName)}</span>`;

      const countdown = document.createElement('span');
      countdown.className = 'dbg-flag-countdown';
      countdown.textContent = `${labels.expiresIn} ${formatCountdown(flag.expirationDate)}`;

      const extend = document.createElement('button');
      extend.type = 'button';
      extend.className = 'btn btn-ghost';
      extend.textContent = labels.extend;
      extend.addEventListener('click', () => {
        vscode.postMessage({
          type: 'extendTraceFlag',
          flagId: flag.id,
          durationMs: Number(durationSel.value),
        });
      });

      const stop = document.createElement('button');
      stop.type = 'button';
      stop.className = 'btn btn-ghost dbg-stop-btn';
      stop.textContent = labels.stop;
      stop.addEventListener('click', () => {
        vscode.postMessage({ type: 'stopTraceFlag', flagId: flag.id });
      });

      row.appendChild(info);
      row.appendChild(countdown);
      row.appendChild(extend);
      row.appendChild(stop);
      flagsEl.appendChild(row);
    }
    startCountdown();
  }

  function startCountdown() {
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = setInterval(() => {
      const rows = flagsEl.querySelectorAll('.dbg-flag-row');
      if (!rows.length) {
        clearInterval(countdownTimer);
        countdownTimer = null;
        return;
      }
      rows.forEach((row) => {
        const expires = row.getAttribute('data-expires') ?? '';
        const label = row.querySelector('.dbg-flag-countdown');
        if (!label) return;
        const remaining = formatCountdown(expires);
        label.textContent = remaining ? `${labels.expiresIn} ${remaining}` : labels.expired;
      });
    }, 1000);
  }

  // ── Wiring ──────────────────────────────────────────────────────────────

  segEl.addEventListener('click', (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    const next = target.getAttribute('data-entity');
    if (next) setMode(/** @type {any} */ (next));
  });

  searchInput.addEventListener('input', () => {
    if (searchTimer) clearTimeout(searchTimer);
    const term = searchInput.value.trim();
    if (term.length < 2) {
      resultsEl.innerHTML = '';
      return;
    }
    searchTimer = setTimeout(() => {
      vscode.postMessage({
        type: 'searchTraceEntities',
        term,
        kind: mode === 'apex' ? 'apex' : 'user',
      });
    }, 300);
  });

  presetSel.addEventListener('change', () => {
    updatePresetHint();
    if (customOpen) renderCustomLevels();
    ctx.onStateChange({ presetId: presetSel.value });
  });

  customToggle.addEventListener('click', () => {
    customOpen = !customOpen;
    customEl.style.display = customOpen ? '' : 'none';
    customToggle.classList.toggle('active', customOpen);
    if (customOpen) renderCustomLevels();
  });

  durationSel.addEventListener('change', () => {
    ctx.onStateChange({ durationMs: Number(durationSel.value) });
  });

  startBtn.addEventListener('click', () => {
    errorEl.style.display = 'none';
    if (!selectedEntity) {
      showError(labels.selectEntityFirst);
      return;
    }
    const levels = customLevels();
    statusEl.textContent = '…';
    vscode.postMessage({
      type: 'startTraceFlag',
      entityId: selectedEntity.id,
      logType: selectedEntity.kind === 'user' ? 'USER_DEBUG' : 'CLASS_TRACING',
      durationMs: Number(durationSel.value),
      ...(levels ? { customLevels: levels } : { presetId: presetSel.value }),
    });
  });

  function showError(/** @type {string} */ message) {
    statusEl.textContent = '';
    errorEl.textContent = message;
    errorEl.style.display = '';
  }

  for (const option of DURATION_OPTIONS) {
    const el = document.createElement('option');
    el.value = String(option.ms);
    el.textContent = option.label;
    durationSel.appendChild(el);
  }

  return {
    /** Hydrate from the `loadDebugLogsSetup` round-trip. */
    applySetup(/** @type {any} */ data) {
      presets = data.presets ?? [];
      systemUsers = data.systemUsers ?? [];
      currentUser = data.currentUser ?? null;
      traceFlags = data.traceFlags ?? [];
      renderPresets();

      const org = ctx.getOrgData();
      const sensitive = org && (!org.sandboxName || org.isProtectedOrg);
      const stored = data.state?.presetId;
      const wanted = sensitive ? 'production-safe' : (stored ?? data.recommendedPresetId);
      if (presets.some((p) => p.id === wanted)) presetSel.value = wanted;
      updatePresetHint();
      if (sensitive) {
        presetHint.insertAdjacentHTML(
          'beforeend',
          `<div class="dbg-warning">${escapeHtml(labels.sensitiveOrgNote)}</div>`,
        );
      }

      if (data.state?.durationMs) durationSel.value = String(data.state.durationMs);
      setMode('me');
      renderFlags();
      statusEl.textContent = '';
    },
    setTraceFlags(/** @type {any[]} */ flags) {
      traceFlags = flags ?? [];
      renderFlags();
      statusEl.textContent = '';
    },
    showEntities(/** @type {any[]} */ entities) {
      renderEntityList(entities);
    },
    showError,
    /** Pre-fill the picker from an AI "Better logging next time" suggestion. */
    applySuggestion(/** @type {{presetId?: string, levels?: any}} */ suggestion) {
      if (suggestion.presetId && presets.some((p) => p.id === suggestion.presetId)) {
        presetSel.value = suggestion.presetId;
        updatePresetHint();
      }
      if (suggestion.levels) {
        customOpen = true;
        customEl.style.display = '';
        customToggle.classList.add('active');
        renderCustomLevels();
        customEl.querySelectorAll('select[data-category]').forEach((el) => {
          const select = /** @type {HTMLSelectElement} */ (el);
          const value = suggestion.levels[String(select.dataset.category)];
          if (value) select.value = value;
        });
      }
      document.getElementById('dbg-trace-card')?.scrollIntoView({ behavior: 'smooth' });
    },
    reset() {
      traceFlags = [];
      selectEntity(null);
      flagsEl.innerHTML = '';
      resultsEl.innerHTML = '';
      if (countdownTimer) {
        clearInterval(countdownTimer);
        countdownTimer = null;
      }
    },
  };
}

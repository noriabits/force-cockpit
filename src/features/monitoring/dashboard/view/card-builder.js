// @ts-check
// Builds the view-mode card shell for a monitoring config: the outer card with
// its data-* attributes, the header (drag handle, title + private badge, type
// selector, Edit + Refresh buttons), the content area (metric div / table
// wrapper / chart canvas), and the status + error-box area. Owns no state — the
// renderers, drag wiring, refresh scheduler and the edit/refresh callbacks are
// injected via ctx so it never reaches into the orchestrator's scope.
import { CHART_TYPES_WITH_CANVAS } from './chart-rendering';

/**
 * @typedef {Object} CardBuilderCtx
 * @property {any} labels
 * @property {() => boolean} getConnected
 * @property {{ switchChartType: Function }} chartRenderer
 * @property {{ makeCardDraggable: (card: HTMLElement, id: string) => void }} dragOrder
 * @property {(cfg: any) => void} setupAutoRefresh
 * @property {(cfg: any) => void} triggerQuery
 * @property {(cfg: any, card: HTMLElement) => void} onEditClick
 */

/**
 * @param {CardBuilderCtx} ctx
 */
export function createCardBuilder(ctx) {
  const {
    labels: L,
    getConnected,
    chartRenderer,
    dragOrder,
    setupAutoRefresh,
    triggerQuery,
    onEditClick,
  } = ctx;

  // ── Content area ───────────────────────────────────────────────────────────
  /** @param {any} cfg */
  function buildCardContentArea(cfg) {
    if (cfg.chartType === 'metric') {
      const metricEl = document.createElement('div');
      metricEl.className = 'monitoring-metric-display';
      return metricEl;
    } else if (cfg.chartType === 'table') {
      const tableWrapper = document.createElement('div');
      tableWrapper.className = 'monitoring-table-wrapper';
      return tableWrapper;
    } else {
      // Canvas for chart types (bar, line, pie, doughnut)
      const canvasWrapper = document.createElement('div');
      canvasWrapper.className = 'monitoring-canvas-wrapper';
      const canvas = document.createElement('canvas');
      canvas.id = 'chart-' + cfg.id.replace(/\//g, '-');
      canvasWrapper.appendChild(canvas);
      return canvasWrapper;
    }
  }

  function buildCardStatusArea() {
    const fragment = document.createDocumentFragment();
    const status = document.createElement('span');
    status.className = 'monitoring-status';
    fragment.appendChild(status);
    // Error box (must be empty in HTML per convention)
    const errorBox = document.createElement('div');
    errorBox.className = 'error-box';
    errorBox.style.display = 'none';
    fragment.appendChild(errorBox);
    return fragment;
  }

  // ── Type selector ──────────────────────────────────────────────────────────
  /** @param {any} cfg */
  function buildTypeSelect(cfg) {
    const typeSelect = document.createElement('select');
    typeSelect.className = 'monitoring-chart-type-select';
    for (const t of CHART_TYPES_WITH_CANVAS) {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = L.chartTypes[t];
      if (t === cfg.chartType) opt.selected = true;
      typeSelect.appendChild(opt);
    }
    typeSelect.disabled = !getConnected();
    typeSelect.addEventListener('change', () => {
      chartRenderer.switchChartType(cfg, typeSelect.value);
    });
    return typeSelect;
  }

  // ── Card header ────────────────────────────────────────────────────────────
  /** @param {any} cfg */
  function buildCardHeader(cfg) {
    const header = document.createElement('div');
    header.className = 'monitoring-card-header';

    const dragHandle = document.createElement('span');
    dragHandle.className = 'monitoring-drag-handle';
    dragHandle.textContent = '⠿';
    dragHandle.title = 'Drag to reorder';
    dragHandle.addEventListener('mousedown', () => {
      const card = /** @type {HTMLElement | null} */ (header.parentElement);
      if (!card) return;
      card.draggable = true;
      // Reset draggable once the press ends, so text selection works elsewhere on the card.
      // mouseup fires on a click without drag; dragend fires after a real drag (mouseup is
      // suppressed by the browser during a drag operation, hence both listeners).
      const reset = () => {
        card.draggable = false;
        document.removeEventListener('mouseup', reset);
        document.removeEventListener('dragend', reset);
      };
      document.addEventListener('mouseup', reset);
      document.addEventListener('dragend', reset);
    });
    header.appendChild(dragHandle);

    const title = document.createElement('span');
    title.className = 'monitoring-card-title';
    title.textContent = cfg.name;
    title.title = cfg.name;
    if (cfg.source === 'private') {
      const badge = document.createElement('span');
      badge.className = 'private-badge';
      badge.textContent = L.badgePrivate;
      badge.title = L.labelPrivate;
      title.appendChild(badge);
    }

    const actions = document.createElement('div');
    actions.className = 'monitoring-card-actions';

    // Type selector only for canvas-based chart types
    if (CHART_TYPES_WITH_CANVAS.includes(cfg.chartType)) {
      actions.appendChild(buildTypeSelect(cfg));
    }

    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-secondary btn-sm';
    editBtn.textContent = L.btnEdit;
    editBtn.disabled = !getConnected();
    editBtn.addEventListener('click', () => {
      const card = /** @type {HTMLElement} */ (header.parentElement);
      onEditClick(cfg, card);
    });

    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'btn btn-primary btn-sm monitoring-refresh-btn';
    refreshBtn.textContent = L.btnRefresh;
    refreshBtn.disabled = !getConnected();
    refreshBtn.addEventListener('click', () => {
      triggerQuery(cfg);
    });

    actions.appendChild(editBtn);
    actions.appendChild(refreshBtn);
    header.appendChild(title);
    header.appendChild(actions);
    return header;
  }

  // ── View-mode card ───────────────────────────────────────────────────────
  /** @param {any} cfg */
  function buildViewCard(cfg) {
    const card = document.createElement('div');
    card.className = 'card monitoring-card';
    card.setAttribute('data-config-id', cfg.id);
    card.setAttribute('data-folder', cfg.folder);
    card.setAttribute('data-source', cfg.source || '');
    card.setAttribute('data-search-text', cfg.name + ' ' + cfg.description + ' ' + cfg.folder);
    // Drag is gated by the drag handle (see buildCardHeader). Keeping draggable=false
    // by default lets users select and copy text inside the card (e.g. table cells).
    card.draggable = false;

    dragOrder.makeCardDraggable(card, cfg.id);

    card.appendChild(buildCardHeader(cfg));

    if (cfg.description) {
      const desc = document.createElement('p');
      desc.className = 'card-description';
      desc.style.margin = '0';
      desc.textContent = cfg.description;
      card.appendChild(desc);
    }

    card.appendChild(buildCardContentArea(cfg));
    card.appendChild(buildCardStatusArea());

    if (cfg.refreshInterval > 0) {
      setupAutoRefresh(cfg);
    }

    return card;
  }

  return { buildViewCard };
}

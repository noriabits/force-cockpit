// @ts-check
// Drag-to-reorder for the monitoring card grid. Owns the `dragSrcId` so both
// the grid-level live-swap dragover and the per-card dragstart/dragend listeners
// stay in one place. Per-card dragover with Y-only midpoint logic doesn't work
// in a 2-D grid, so we find the closest visible sibling under the cursor and
// reorder continuously as the user drags.

/**
 * @typedef {Object} DragOrderCtx
 * @property {HTMLElement} grid
 * @property {() => any[]} getConfigs
 * @property {{ postMessage: (msg: any) => void }} vscode
 */

/**
 * @param {DragOrderCtx} ctx
 */
export function createDragOrder(ctx) {
  const { grid, getConfigs, vscode } = ctx;

  /** configId currently being dragged, or null */
  let dragSrcId = /** @type {string | null} */ (null);

  /**
   * @param {HTMLElement} excluded
   * @param {number} x
   * @param {number} y
   * @returns {HTMLElement | null}
   */
  function findClosestCard(excluded, x, y) {
    const cards = /** @type {HTMLElement[]} */ (
      Array.from(grid.querySelectorAll('.card[data-config-id]'))
    ).filter((c) => c !== excluded && c.style.display !== 'none');
    let best = null;
    let bestDist = Infinity;
    for (const card of cards) {
      const rect = card.getBoundingClientRect();
      const dx = x - (rect.left + rect.width / 2);
      const dy = y - (rect.top + rect.height / 2);
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        best = card;
      }
    }
    return best;
  }

  function nextAvailablePosition() {
    let max = -1;
    for (const c of getConfigs()) {
      if (typeof c.position === 'number' && c.position > max) max = c.position;
    }
    return max + 1;
  }

  function saveCardOrder() {
    const configs = getConfigs();
    const allCards = Array.from(grid.querySelectorAll('.card[data-config-id]'));
    const positions = allCards.map((card, idx) => ({
      id: card.getAttribute('data-config-id') || '',
      position: idx,
      source: card.getAttribute('data-source') || '',
    }));
    for (const { id, position } of positions) {
      const cfg = configs.find((/** @type {any} */ c) => c.id === id);
      if (cfg) cfg.position = position;
    }
    vscode.postMessage({ type: 'saveMonitoringPositions', positions });
  }

  /** Wire the grid-level live-swap dragover. Call once at init. */
  function init() {
    grid.addEventListener('dragover', (e) => {
      if (!dragSrcId) return;
      const dragCard = /** @type {HTMLElement | null} */ (
        grid.querySelector(`.card[data-config-id="${dragSrcId}"]`)
      );
      if (!dragCard) return;
      e.preventDefault();
      const dt = /** @type {DataTransfer | null} */ (/** @type {DragEvent} */ (e).dataTransfer);
      if (dt) dt.dropEffect = 'move';
      const target = findClosestCard(dragCard, e.clientX, e.clientY);
      if (!target) return;
      const rect = target.getBoundingClientRect();
      const isAfter = e.clientX > rect.left + rect.width / 2;
      if (isAfter) {
        if (target.nextSibling !== dragCard) {
          grid.insertBefore(dragCard, target.nextSibling);
        }
      } else {
        if (dragCard.nextSibling !== target) {
          grid.insertBefore(dragCard, target);
        }
      }
    });
  }

  /**
   * Wire dragstart/dragend on a view-mode card. Drag is gated by the drag
   * handle (which toggles `card.draggable`); dragstart is suppressed while any
   * card is in edit mode.
   * @param {HTMLElement} card
   * @param {string} cfgId
   */
  function makeCardDraggable(card, cfgId) {
    card.addEventListener('dragstart', (e) => {
      if (grid.querySelector('.monitoring-edit-form')) {
        e.preventDefault();
        return;
      }
      dragSrcId = cfgId;
      card.classList.add('monitoring-card--dragging');
      /** @type {DataTransfer} */ (e.dataTransfer).effectAllowed = 'move';
    });

    card.addEventListener('dragend', () => {
      card.draggable = false;
      card.classList.remove('monitoring-card--dragging');
      const wasDragging = dragSrcId === cfgId;
      dragSrcId = null;
      if (wasDragging) saveCardOrder();
    });
  }

  return { init, makeCardDraggable, nextAvailablePosition, saveCardOrder };
}

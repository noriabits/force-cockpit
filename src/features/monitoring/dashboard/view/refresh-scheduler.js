// @ts-check
// Auto-refresh timer lifecycle for the monitoring dashboard. Owns the
// `refreshTimers` Map (one interval per config). Notification-enabled configs
// are skipped — the extension host's BackgroundRefresher drives those so they
// keep firing even when the panel is closed (see notification-config.ts). Each
// tick is gated on the panel being visible and still connected, both read live
// via ctx getters.
import { hasNotifications } from '../notification-config';

/** Minimum auto-refresh interval in seconds to prevent API overload */
const MIN_REFRESH_INTERVAL = 10;

/**
 * @typedef {Object} RefreshSchedulerCtx
 * @property {() => boolean} getConnected
 * @property {() => boolean} getIsVisible
 * @property {(cfg: any) => void} triggerQuery
 */

/**
 * @param {RefreshSchedulerCtx} ctx
 */
export function createRefreshScheduler(ctx) {
  const { getConnected, getIsVisible, triggerQuery } = ctx;
  /** @type {Map<string, ReturnType<typeof setInterval>>} configId → auto-refresh interval */
  const refreshTimers = new Map();

  /** @param {string} configId */
  function clearAutoRefresh(configId) {
    const id = refreshTimers.get(configId);
    if (id) {
      clearInterval(id);
      refreshTimers.delete(configId);
    }
  }

  /** @param {any} cfg */
  function setupAutoRefresh(cfg) {
    clearAutoRefresh(cfg.id);
    if (hasNotifications(cfg)) return; // host owns the timer for notification configs
    if (cfg.refreshInterval > 0) {
      // Enforce minimum interval: at least 10 seconds to prevent API rate limit issues
      const intervalMs = Math.max(cfg.refreshInterval * 1000, MIN_REFRESH_INTERVAL * 1000);
      const id = setInterval(() => {
        // Only trigger query if panel is visible and still connected
        if (getConnected() && getIsVisible()) triggerQuery(cfg);
      }, intervalMs);
      refreshTimers.set(cfg.id, id);
    }
  }

  function clearAllRefreshTimers() {
    refreshTimers.forEach((/** @type {any} */ id) => clearInterval(id));
    refreshTimers.clear();
  }

  return { setupAutoRefresh, clearAllRefreshTimers };
}

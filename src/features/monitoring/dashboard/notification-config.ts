import type { MonitoringConfig } from './types';

/**
 * A config is "notification-enabled" when it has any value-field threshold OR
 * `notifyOnIncrease: true`. These configs are driven by the extension host's
 * BackgroundRefresher (so they keep firing notifications even when the panel is
 * closed); the webview must NOT also run its own timer for them or notifications
 * would double-fire. Shared between the host (BackgroundRefresher) and the
 * webview (refresh-scheduler) so both agree on who owns the timer.
 *
 * Kept as a leaf module with no `vscode` import so esbuild can bundle it into
 * the webview view bundle.
 */
export function hasNotifications(cfg: MonitoringConfig): boolean {
  if (cfg.notifyOnIncrease) return true;
  return cfg.valueFields?.some((vf) => vf.threshold != null) ?? false;
}

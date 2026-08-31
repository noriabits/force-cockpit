import * as path from 'path';
import type { FeatureModule, FeatureModuleFactory } from '../../FeatureModule';
import type { FeatureContext } from '../../FeatureContext';
import { MonitoringDashboardService } from './MonitoringDashboardService';
import type { MonitoringConfig } from './types';
import { BackgroundRefresher } from './BackgroundRefresher';
import { loadPersistedSnoozes } from './notifications';
import { buildMonitoringRoutes, loadHiddenBuiltins } from './routes';

export interface MonitoringFeature {
  factory: FeatureModuleFactory;
  /** Background refresher — start/stop driven by extension.ts based on connection state. */
  refresher: BackgroundRefresher;
  /** Refresh the in-host config snapshot (used after activate / connectionChanged). */
  reloadConfigs: () => Promise<MonitoringConfig[]>;
}

export function createMonitoringDashboardFeature(ctx: FeatureContext): MonitoringFeature {
  loadPersistedSnoozes(ctx.workspaceState);

  // `ctx.paths` carries the cockpit BASE dirs; the `monitoring` sub-path is
  // this feature's to add. Passing a base through raw is silently destructive —
  // `loadYamlItems` walks `{category}/{sub-category}/*.yaml` from whatever it is
  // given, so the base would make `scripts/` and `logs/` look like chart
  // categories. Covered by paths.test.ts.
  const paths = {
    builtInPath: path.join(ctx.paths.builtIn, 'monitoring'),
    userPath: path.join(ctx.paths.user, 'monitoring'),
    privatePath: path.join(ctx.paths.private, 'monitoring'),
  };

  // Construction is eager and unconditional: the FeatureContext exists from
  // activation, so the refresher can poll notification-enabled dashboards
  // before the panel is ever opened. (This used to be built lazily inside the
  // factory when no ConnectionManager was supplied, which needed null-checks
  // throughout plus a no-op proxy for extension.ts to hold — all of which the
  // context makes unnecessary.)
  const service = new MonitoringDashboardService(ctx.connectionManager, paths);
  const refresher = new BackgroundRefresher({
    service,
    connectionManager: ctx.connectionManager,
    workspaceState: ctx.workspaceState,
    postToWebview: ctx.postToWebview,
    outputChannel: ctx.outputChannel,
  });

  // Takes no argument on purpose: the service and refresher above already closed
  // over the activation-time context, and there is only ever one of it. The
  // `FeatureModuleFactory` annotation is kept so this still slots into
  // `allFeatures`, but it is documentation here, not a dependency.
  const factory: FeatureModuleFactory = (): FeatureModule => {
    const base = path.join('dist', 'features', 'monitoring', 'dashboard');
    return {
      id: 'monitoring-dashboard',
      tab: 'monitoring',
      htmlPath: path.join(base, 'view.html'),
      jsPath: path.join(base, 'view.js'),
      cssPath: path.join(base, 'view.css'),
      labelsPath: path.join(base, 'labels.js'),
      routes: buildMonitoringRoutes({
        service,
        refresher,
        connectionManager: ctx.connectionManager,
        workspaceState: ctx.workspaceState,
        outputChannel: ctx.outputChannel,
      }),
    };
  };

  const reloadConfigs = async (): Promise<MonitoringConfig[]> =>
    service.loadConfigs(loadHiddenBuiltins(ctx.workspaceState));

  return { factory, refresher, reloadConfigs };
}

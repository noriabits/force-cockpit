import * as path from 'path';
import type { ConnectionManager } from '../salesforce/connection';
import type { FeatureModule, FeatureModuleFactory, RouteDescriptor } from './FeatureModule';

export function defineFeature<S>(options: {
  id: string;
  tab: string;
  Service: new (cm: ConnectionManager) => S;
  routes: (service: S) => Record<string, RouteDescriptor>;
}): FeatureModuleFactory {
  return (connectionManager): FeatureModule => {
    const service = new options.Service(connectionManager);
    const base = path.join('dist', 'features', options.tab, options.id);
    return {
      id: options.id,
      tab: options.tab,
      htmlPath: path.join(base, 'view.html'),
      jsPath: path.join(base, 'view.js'),
      cssPath: path.join(base, 'view.css'),
      labelsPath: path.join(base, 'labels.js'),
      routes: options.routes(service),
    };
  };
}

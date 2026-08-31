import * as path from 'path';
import type { ConnectionManager } from '../salesforce/connection';
import type { WebviewToHostType } from '../shared/protocol';
import type { FeatureModule, FeatureModuleFactory, RouteDescriptor } from './FeatureModule';
import type { FeatureContext } from './FeatureContext';

/**
 * Register a teardown for something `create` acquired — an event listener, a
 * provider registration, a timer. Called by MainPanel when the panel is
 * disposed, most-recently-registered first, so a reopened panel re-creates the
 * feature without leaking.
 */
export type OnDispose = (teardown: () => void) => void;

/**
 * How the feature's service is built. A discriminated union rather than two
 * optional fields: with `Service?` + `create?` both optional, omitting BOTH
 * compiled and then threw a TypeError at activation. Exactly one is required,
 * and supplying both is also rejected.
 */
type ServiceSpec<S> =
  | { Service: new (cm: ConnectionManager) => S; create?: never }
  | { create: (ctx: FeatureContext, onDispose: OnDispose) => S; Service?: never };

export function defineFeature<S>(
  options: {
    id: string;
    tab: string;
    routes: (
      service: S,
      ctx: FeatureContext,
    ) => Partial<Record<WebviewToHostType, RouteDescriptor>>;
    /**
     * Release something the SERVICE itself owns. Optional, and rarely what you
     * want: anything `create` acquired should register its own teardown through
     * the `onDispose` callback it is handed, right where it was acquired.
     *
     * This exists for the `Service`-class branch, which gets no such callback.
     * It used to be the only option, which pushed features into returning the
     * teardown's own ingredients — soql's `create` returned the
     * ConnectionManager and its listener function purely so this could reach
     * them, and `routes` then destructured around both.
     */
    dispose?: (service: S) => void;
  } & ServiceSpec<S>,
): FeatureModuleFactory {
  return (ctx): FeatureModule => {
    const teardowns: Array<() => void> = [];
    const onDispose: OnDispose = (fn) => teardowns.push(fn);
    // `create` is `undefined` in the `Service` branch of the union, so this
    // truthiness check narrows — no non-null assertion needed on either side.
    const service = options.create
      ? options.create(ctx, onDispose)
      : new options.Service(ctx.connectionManager);
    const base = path.join('dist', 'features', options.tab, options.id);
    const dispose = options.dispose;
    if (dispose) onDispose(() => dispose(service));
    return {
      id: options.id,
      tab: options.tab,
      htmlPath: path.join(base, 'view.html'),
      jsPath: path.join(base, 'view.js'),
      cssPath: path.join(base, 'view.css'),
      labelsPath: path.join(base, 'labels.js'),
      routes: options.routes(service, ctx),
      // Always present, even when empty: a feature that registers nothing still
      // has a valid (no-op) teardown, and callers should not have to care.
      // Reverse order, so teardown unwinds acquisition.
      dispose: () => {
        for (const fn of teardowns.reverse()) fn();
        teardowns.length = 0;
      },
    };
  };
}

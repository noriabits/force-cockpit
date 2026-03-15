import type { FeatureModuleFactory } from './FeatureModule';
import { cloneUserFeature } from './utils/clone-user/index';
import { reactivateOmniscriptFeature } from './utils/reactivate-omniscript/index';
/**
 * Central feature registry.
 * To add a new feature: import its factory and add it to this array.
 * No other files need to change.
 */
export const featureRegistry: FeatureModuleFactory[] = [
  cloneUserFeature,
  reactivateOmniscriptFeature,
  // Add new features here ↑
];

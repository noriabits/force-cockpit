// Builds a FeatureContext for tests.
//
// A feature factory takes the whole shared context, but a given test usually
// cares about one or two fields of it. This fills in inert defaults for the
// rest so a test states only what it actually exercises.
import type { CockpitPaths, FeatureContext } from '../FeatureContext';
import type { CockpitConfig } from '../../utils/config';

/**
 * Deliberately NON-EMPTY and realistic. These were all `''` at first, which made
 * every path assertion vacuously true and let a regression through where two
 * features passed the cockpit BASE dir straight to their repository instead of
 * adding their own `scripts`/`monitoring` sub-path. Keep them distinguishable so
 * a wrong join is visible in a diff.
 */
const DEFAULT_PATHS: CockpitPaths = {
  builtIn: '/ext/force-cockpit',
  user: '/ws/force-cockpit',
  private: '/ws/force-cockpit/private',
  workspaceRoot: '/ws',
  logs: '/ws/force-cockpit/logs',
};

/**
 * The SECOND field production code reads eagerly, so it gets the same treatment
 * as `paths`: typed precisely, outside the whole-object cast below.
 *
 * `debugLogsFeature` reads `ctx.getConfig().debugLogNoise` in its factory body,
 * and this fixture is what `paths.test.ts` builds it from — so an object literal
 * missing that key (which the cast happily hid) seeded the noise filter with
 * `undefined` in every test that constructs the feature. Matches `config.ts`'s
 * own DEFAULTS rather than inventing values, so the fixture is not a second,
 * quietly-diverging idea of what the defaults are.
 */
const DEFAULT_CONFIG: CockpitConfig = {
  apiVersion: '66.0',
  protectedSandboxes: [],
  skillsPaths: ['.claude/skills', '.github/skills'],
  debugLogNoise: {},
};

/**
 * `overrides` for a `FeatureContext`, except that `paths` takes a PARTIAL and
 * merges PER KEY — so a test can pass `{ paths: { user: '/x' } }` and keep
 * realistic values for the rest.
 *
 * `paths` is split out of the `Partial<>` for exactly that reason: `Partial<T>`
 * makes a key optional but still demands the WHOLE `CockpitPaths` when present,
 * so the call above was a type error and every caller reached for a cast — which
 * is worth avoiding in the fixture the path assertions all rest on.
 */
export type FakeContextOverrides = Partial<Omit<FeatureContext, 'paths'>> & {
  paths?: Partial<CockpitPaths>;
};

/**
 * The `paths` merge is applied AFTER the outer spread on purpose: with
 * `paths: { ...DEFAULT_PATHS, ...overrides.paths }` written inline before
 * `...overrides`, the outer spread replaced the whole `paths` object and the
 * inner merge was unreachable — a partial override silently left `builtIn`,
 * `logs` and friends `undefined`.
 */
export function fakeFeatureContext(overrides: FakeContextOverrides = {}): FeatureContext {
  const noop = () => {};
  return {
    connectionManager: {
      on: noop,
      off: noop,
      getCurrentOrg: () => null,
    },
    workspaceState: { get: (_k: string, d: unknown) => d, update: async () => {} },
    describeService: {},
    gateway: { listModels: async () => [], send: async function* () {} },
    workspaceSearch: {
      searchFiles: async () => ({ paths: [], truncated: false }),
      readFile: async () => ({ error: 'not available in tests' }),
    },
    skillsRepo: { listSkills: async () => [], readSkill: async () => null },
    outputChannel: { appendLine: noop },
    postToWebview: noop,
    getConfig: (): CockpitConfig => DEFAULT_CONFIG,
    ...overrides,
    // AFTER the outer spread — see the note above.
    paths: { ...DEFAULT_PATHS, ...overrides.paths },
    // The inert defaults above are structurally incomplete (a ConnectionManager
    // stub with three methods, an empty DescribeService), so the whole object
    // needs this cast and nothing in it is checked.
    //
    // `paths` and `getConfig` are the exceptions, because they are the two
    // fields a feature factory reads EAGERLY — in its own body, before any route
    // runs — so a wrong value there is already wrong by the time a test does
    // anything. Both are typed precisely (`FakeContextOverrides` for `paths`, a
    // `CockpitConfig` return annotation for `getConfig`) so the assertions in
    // paths.test.ts rest on something real. Give any further eagerly-read field
    // the same treatment rather than widening this cast's reach.
  } as unknown as FeatureContext;
}

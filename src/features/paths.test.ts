// Pins the directory each feature actually resolves out of `FeatureContext.paths`.
//
// `ctx.paths` carries the cockpit BASE dirs and every consumer adds its own
// sub-path. Nothing in the type system can tell two `string` paths apart, so a
// feature that forgets its sub-path compiles, passes every other test, and
// fails only at runtime — silently:
//
//   * `loadYamlItems` walks `{category}/{sub-category}/*.yaml` from whatever it
//     is handed, so the base dir makes sibling folders (`monitoring/`, `logs/`,
//     `.describe-cache/`) look like categories — the Scripts tab renders every
//     monitoring config as an invalid script, and vice versa.
//   * `ScriptRepository.save` joins the category onto `userPath`, so a new
//     script lands in `force-cockpit/{category}/` and the next load cannot find
//     it under the same id.
//   * `ScriptRepository.saveExecutionLog` derives its logs dir as
//     `path.dirname(userPath) + '/logs'` — which assumes `userPath` ends in
//     `/scripts`. Given the base it resolves to `{workspaceRoot}/logs`, outside
//     the gitignored cockpit folder, while the Logs tab reads `ctx.paths.logs`.
//
// That regression shipped once. These assertions are the guard.
//
// Everything here invokes production code. An earlier draft also "asserted"
// things like `expect(path.join(USER, 'scripts')).not.toBe(USER)` — that tests
// Node's path.join, runs none of this codebase, and cannot fail.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { fakeFeatureContext } from './__fixtures__/featureContext';
import type { CockpitConfig } from '../utils/config';

vi.mock('vscode', () => ({
  workspace: {
    registerTextDocumentContentProvider: () => ({ dispose() {} }),
    registerFileSystemProvider: () => ({ dispose() {} }),
    openTextDocument: async () => ({}),
  },
  window: { showTextDocument: async () => ({}) },
  Uri: { parse: (u: string) => ({ toString: () => u }), file: (f: string) => ({ fsPath: f }) },
  EventEmitter: class {
    event = () => ({ dispose() {} });
    fire() {}
    dispose() {}
  },
  FileType: { File: 1 },
}));

const ctx = fakeFeatureContext();
const USER = ctx.paths.user; //     /ws/force-cockpit
const BUILTIN = ctx.paths.builtIn; //  /ext/force-cockpit
const PRIVATE = ctx.paths.private; //  /ws/force-cockpit/private

// The logs-dir consumers run against a REAL temp tree rather than an fs mock:
// the question is "does a write land where the reader looks", and only real I/O
// answers that end to end. Also exercises the fixture's per-key `paths` merge.
const tmpRoots: string[] = [];
function tmpCockpit() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-paths-'));
  tmpRoots.push(root);
  const user = path.join(root, 'force-cockpit');
  return {
    builtIn: path.join(root, 'ext', 'force-cockpit'),
    user,
    private: path.join(user, 'private'),
    workspaceRoot: root,
    logs: path.join(user, 'logs'),
  };
}
afterEach(() => {
  for (const r of tmpRoots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

/**
 * Runs the real `yamlScriptsFeature` factory and returns the path bag it hands
 * `YamlScriptsService`. Both tests below go through this, so neither
 * re-implements the join it is meant to be checking.
 */
async function scriptPathsFor(c: ReturnType<typeof fakeFeatureContext>) {
  const captured: Record<string, string>[] = [];
  vi.doMock('./utils/yaml-scripts/YamlScriptsService', () => ({
    YamlScriptsService: class {
      constructor(_cm: unknown, paths: Record<string, string>) {
        captured.push(paths);
      }
    },
  }));
  vi.resetModules();
  const { yamlScriptsFeature } = await import('./utils/yaml-scripts/index');
  yamlScriptsFeature(c);
  vi.doUnmock('./utils/yaml-scripts/YamlScriptsService');
  return captured[0];
}

describe('yaml-scripts resolves the scripts/ sub-tree', () => {
  it('adds `scripts` to all three base dirs', async () => {
    expect(await scriptPathsFor(ctx)).toMatchObject({
      builtInPath: path.join(BUILTIN, 'scripts'),
      userPath: path.join(USER, 'scripts'),
      privatePath: path.join(PRIVATE, 'scripts'),
      workspaceRoot: ctx.paths.workspaceRoot,
    });
  });

  it('lands saveExecutionLog in the SAME dir the Logs tab reads', async () => {
    // The real invariant, exercised through ScriptRepository rather than by
    // re-implementing its join: the logs dir is `dirname(userPath) + '/logs'`,
    // which only equals `ctx.paths.logs` while userPath ends in `/scripts`.
    const p = tmpCockpit();
    // The paths the FEATURE resolves, not ones hand-joined here — so a feature
    // that stops adding `scripts` fails this test too, not just the one above.
    const featurePaths = await scriptPathsFor(fakeFeatureContext({ paths: p }));
    vi.resetModules();
    const { ScriptRepository } = await import('./utils/yaml-scripts/persistence/ScriptRepository');
    new ScriptRepository(featurePaths as never).saveExecutionLog('My Script', 'some debug output');

    const written = fs.readdirSync(p.logs).filter((f) => f.endsWith('.log'));
    expect(written).toHaveLength(1);
    expect(fs.readFileSync(path.join(p.logs, written[0]), 'utf8')).toContain('some debug output');
  });
});

describe('monitoring resolves the monitoring/ sub-tree', () => {
  it('adds `monitoring` to all three base dirs', async () => {
    const captured: Record<string, string>[] = [];
    vi.doMock('./monitoring/dashboard/MonitoringDashboardService', () => ({
      MonitoringDashboardService: class {
        constructor(_cm: unknown, paths: Record<string, string>) {
          captured.push(paths);
        }
        loadConfigs = async () => [];
      },
    }));
    vi.doMock('./monitoring/dashboard/BackgroundRefresher', () => ({
      BackgroundRefresher: class {
        start() {}
        stop() {}
        restart() {}
      },
    }));
    vi.resetModules();
    const { createMonitoringDashboardFeature } = await import('./monitoring/dashboard/index');
    createMonitoringDashboardFeature(ctx);

    expect(captured[0]).toMatchObject({
      builtInPath: path.join(BUILTIN, 'monitoring'),
      userPath: path.join(USER, 'monitoring'),
      privatePath: path.join(PRIVATE, 'monitoring'),
    });
    vi.doUnmock('./monitoring/dashboard/MonitoringDashboardService');
    vi.doUnmock('./monitoring/dashboard/BackgroundRefresher');
  });
});

describe('ctx.paths.logs reaches the features that take it pre-joined', () => {
  // These two are handed an already-joined path rather than deriving one, which
  // makes them exactly the pair a future refactor could mis-wire with no type
  // error. The header names this failure mode; nothing used to exercise it.

  it('execution-logs lists from ctx.paths.logs', async () => {
    const p = tmpCockpit();
    fs.mkdirSync(p.logs, { recursive: true });
    fs.writeFileSync(path.join(p.logs, 'run.log'), 'x');
    fs.writeFileSync(path.join(p.logs, 'ignored.txt'), 'x');

    vi.resetModules();
    const { executionLogsFeature } = await import('./utils/execution-logs/index');
    const feature = executionLogsFeature(fakeFeatureContext({ paths: p }));
    const result = (await feature.routes.loadExecutionLogs!.handler({})) as {
      logs: Array<{ filename: string }>;
    };

    expect(result.logs.map((l) => l.filename)).toEqual(['run.log']);
  });

  it('debug-logs writes a saved analysis into ctx.paths.logs', async () => {
    const p = tmpCockpit();
    vi.resetModules();
    const { debugLogsFeature } = await import('./debug-logs/explorer/index');
    const feature = debugLogsFeature(fakeFeatureContext({ paths: p }));
    await feature.routes.saveApexLogAnalysis!.handler({ logId: '07L1', content: '# report' });

    const file = path.join(p.logs, 'apexlog-07L1-analysis.md');
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('# report');
  });
});

describe('fakeFeatureContext merges paths per key', () => {
  // The fixture is what every path assertion in this file rests on, so its own
  // merge has to hold. It did not: `paths: { ...defaults, ...overrides.paths }`
  // was written BEFORE the outer `...overrides`, which replaced the whole
  // object — a partial override silently produced `undefined` siblings, and the
  // JSDoc promised the opposite.
  //
  // The partial below is passed WITHOUT a cast on purpose: `FakeContextOverrides`
  // splits `paths` out of the `Partial<>` so this call type-checks. It used to
  // need `as never`, and a cast in the test that proves the merge works would
  // have hidden the next signature regression rather than caught it.
  it('keeps realistic defaults for the keys an override does not mention', () => {
    const partial = fakeFeatureContext({ paths: { user: '/custom' } });
    expect(partial.paths.user).toBe('/custom');
    expect(partial.paths.builtIn).toBe(BUILTIN);
    expect(partial.paths.private).toBe(PRIVATE);
    expect(partial.paths.logs).toBeDefined();
    expect(partial.paths.workspaceRoot).toBeDefined();
  });

  it('hands out a COMPLETE CockpitConfig', () => {
    // The other field a feature factory reads eagerly, in its own body:
    // `debugLogsFeature` seeds its noise filter from
    // `ctx.getConfig().debugLogNoise` at construction. The literal here used to
    // omit that key entirely — legal only because the whole fixture is cast —
    // so every test constructing that feature through this fixture built it
    // with `undefined`. The annotation on `getConfig` is what makes a future
    // omission a compile error; this asserts the value, not just the type.
    const config: CockpitConfig = fakeFeatureContext().getConfig();
    expect(config.debugLogNoise).toBeDefined();
    expect(config.skillsPaths.length).toBeGreaterThan(0);
    expect(config.apiVersion).toMatch(/^\d+\.\d+$/);
  });

  it('still lets a full paths object win outright', () => {
    const all = { builtIn: '/b', user: '/u', private: '/p', workspaceRoot: '/w', logs: '/l' };
    expect(fakeFeatureContext({ paths: all }).paths).toEqual(all);
  });
});

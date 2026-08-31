// Everything a feature factory may need, assembled once in extension.ts.
//
// Before this, `FeatureModuleFactory` took only a `ConnectionManager`, so any
// feature needing more — a path, the shared describe cache, the LM gateway —
// could not use `defineFeature` and grew its own bespoke factory with its own
// hand-rolled options bag. Five of seven features ended up that way, and
// extension.ts became a 320-line composition root wiring each bag by hand.
//
// One context object instead: adding a shared dependency is a field here, not a
// new parameter threaded through every call site.
//
// Deliberately NOT a DI container. Everything stays explicit and constructed in
// one place; this is the argument object, not a resolver.

import type { Memento, OutputChannel } from 'vscode';
import type { ConnectionManager } from '../salesforce/connection';
import type { DescribeService } from '../services/describe/DescribeService';
import type { LmGateway, WorkspaceSearch } from '../services/ai/types';
import type { SkillsRepository } from '../services/skills/SkillsRepository';
import type { CockpitConfig } from '../utils/config';
import type { HostMessage } from '../shared/protocol';

/**
 * Resolved once at activation; `user`/`private` honour `forceCockpit.cockpitPath`.
 *
 * **These are BASE dirs. A feature adds its own sub-path** —
 * `path.join(ctx.paths.user, 'scripts')`, `path.join(ctx.paths.private, 'monitoring')`.
 * Handing a base straight to a repository is silently destructive rather than a
 * crash: `loadYamlItems` walks `{category}/{sub-category}/*.yaml` from whatever
 * it is given, so the base turns sibling folders (`logs/`, `.describe-cache/`,
 * and the *other* feature's tree) into categories, and writes then land where
 * the next read will not look. Nothing in the type system distinguishes two
 * `string` paths, so this is pinned by `src/features/paths.test.ts` instead.
 *
 * `logs` is the one pre-joined member, because three consumers share it
 * (execution-logs, debug-logs, and `ScriptRepository.saveExecutionLog`, which
 * derives it as `dirname(userPath) + '/logs'` and so depends on `userPath`
 * still ending in `/scripts`).
 */
export interface CockpitPaths {
  /** Bundled defaults inside the extension — absent in a Marketplace install. */
  builtIn: string;
  /** `{workspace}/force-cockpit` (or `forceCockpit.cockpitPath`). NOT a leaf dir. */
  user: string;
  /** `{user}/private`. NOT a leaf dir. */
  private: string;
  workspaceRoot: string;
  /** Pre-joined `{user}/logs` — shared by three consumers. */
  logs: string;
}

export interface FeatureContext {
  connectionManager: ConnectionManager;
  workspaceState: Memento;
  describeService: DescribeService;
  gateway: LmGateway;
  workspaceSearch: WorkspaceSearch;
  skillsRepo: SkillsRepository;
  paths: CockpitPaths;
  outputChannel: OutputChannel;
  /** No-op while the panel is closed. */
  postToWebview: (message: HostMessage) => void;
  /** Read through a getter so a live config.yaml reload is picked up. */
  getConfig: () => CockpitConfig;
}

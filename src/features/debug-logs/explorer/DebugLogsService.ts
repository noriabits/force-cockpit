// Facade over the Debug Logs collaborators: the Tooling APIs, the pure parsing
// modules and the shared body cache. Holds no vscode imports so it can be
// exercised with a mocked ConnectionManager.
import type { ConnectionManager } from '../../../salesforce/connection';
import { ApexLogApi } from './api/ApexLogApi';
import { EntityLookupApi } from './api/EntityLookupApi';
import { TraceFlagApi } from './api/TraceFlagApi';
import { ToolingRest } from './api/ToolingRest';
import { findPreset } from './debugLevelPresets';
import { LogBodyCache } from './LogBodyCache';
import { buildExecutionTree, pruneDepth } from './parsing/executionTree';
import { detectIssues } from './parsing/issueDetector';
import { parseLog } from './parsing/logLine';
import { isEmptyByContent, resolveNoiseOptions } from './parsing/logNoise';
import { buildSummary } from './parsing/logSummary';
import { extractQueryPlans } from './parsing/queryPlan';
import type {
  ApexLogRow,
  CategoryLevels,
  NoiseOptions,
  ParsedLog,
  TraceEntity,
  TraceFlagInfo,
  TraceLogType,
} from './types';

/** Above this, the parsed events are not shipped to the webview in full. */
const MAX_INLINE_BYTES = 5 * 1024 * 1024;
/** How many bodies the tier-2 noise check fetches at once. */
const CLASSIFY_CONCURRENCY = 4;
/** Depth kept when the tree is sent to the webview / the model. */
const MAX_TREE_DEPTH = 12;

export interface OpenedLog {
  logId: string;
  body: string;
  /** Set when the log was too large to ship in full; only head/tail lines are present. */
  partial: boolean;
  totalLines: number;
  parsed: ParsedLog;
}

export class DebugLogsService {
  private readonly rest: ToolingRest;
  private readonly logs: ApexLogApi;
  private readonly traceFlags: TraceFlagApi;
  private readonly entities: EntityLookupApi;
  private readonly bodies = new LogBodyCache();
  private noiseOptions: NoiseOptions;

  constructor(
    private readonly connectionManager: ConnectionManager,
    noiseOverrides?: Partial<NoiseOptions>,
  ) {
    this.rest = new ToolingRest(connectionManager);
    this.logs = new ApexLogApi(this.rest);
    this.traceFlags = new TraceFlagApi(this.rest);
    this.entities = new EntityLookupApi(this.rest, connectionManager);
    this.noiseOptions = resolveNoiseOptions(noiseOverrides);
  }

  setNoiseOptions(overrides?: Partial<NoiseOptions>): void {
    this.noiseOptions = resolveNoiseOptions(overrides);
  }

  getNoiseOptions(): NoiseOptions {
    return this.noiseOptions;
  }

  /** Drop cached bodies — called when the connected org changes. */
  clearCache(): void {
    this.bodies.clear();
  }

  // ── Logs ────────────────────────────────────────────────────────────────

  async listLogs(limit?: number): Promise<ApexLogRow[]> {
    return this.logs.listLogs(limit);
  }

  async getBody(logId: string): Promise<string> {
    const cached = this.bodies.get(logId);
    if (cached !== undefined) return cached;
    const body = await this.logs.getBody(logId);
    this.bodies.set(logId, body);
    return body;
  }

  /** Fetch + parse a log for the viewer. Huge logs come back head/tail-trimmed. */
  async openLog(logId: string): Promise<OpenedLog> {
    const body = await this.getBody(logId);
    const { header, events } = parseLog(body);
    const summary = buildSummary(events, body);
    const issues = detectIssues(events, summary);
    const tree = pruneDepth(buildExecutionTree(events), MAX_TREE_DEPTH);
    const queryPlans = extractQueryPlans(events);

    const partial = body.length > MAX_INLINE_BYTES;
    const shipped = partial ? [...events.slice(0, 2000), ...events.slice(-2000)] : events;

    return {
      logId,
      body: partial ? '' : body,
      partial,
      totalLines: events.length,
      parsed: { header, events: shipped, summary, issues, tree, queryPlans },
    };
  }

  /** Tier-2 noise check: which of these logs contain nothing observable. */
  async classifyEmptyLogs(logIds: string[]): Promise<{ id: string; empty: boolean }[]> {
    const out: { id: string; empty: boolean }[] = [];
    for (let i = 0; i < logIds.length; i += CLASSIFY_CONCURRENCY) {
      const batch = logIds.slice(i, i + CLASSIFY_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (id) => {
          try {
            return { id, empty: isEmptyByContent(await this.getBody(id)) };
          } catch {
            // A body we cannot read is not evidence of emptiness — keep the row.
            return { id, empty: false };
          }
        }),
      );
      out.push(...results);
    }
    return out;
  }

  async deleteLogs(logIds: string[]): Promise<{ deleted: number; failed: number }> {
    const result = await this.logs.deleteLogs(logIds);
    this.bodies.clear();
    return result;
  }

  // ── Trace flags ─────────────────────────────────────────────────────────

  async listTraceFlags(): Promise<TraceFlagInfo[]> {
    return this.traceFlags.listActive();
  }

  /**
   * Start tracing an entity with a preset, an existing DebugLevel, or custom
   * category levels. Upserts, because only one flag per entity may be active.
   */
  async startTrace(params: {
    entityId: string;
    logType: TraceLogType;
    durationMs: number;
    presetId?: string;
    debugLevelId?: string;
    customLevels?: CategoryLevels;
  }): Promise<{ id: string; expirationDate: string; replaced: boolean }> {
    const debugLevelId = await this.resolveDebugLevelId(params);
    return this.traceFlags.upsertForEntity({
      entityId: params.entityId,
      logType: params.logType,
      debugLevelId,
      durationMs: params.durationMs,
    });
  }

  async extendTrace(flagId: string, durationMs: number): Promise<string> {
    return this.traceFlags.extend(flagId, durationMs);
  }

  async stopTrace(flagId: string): Promise<void> {
    await this.traceFlags.remove(flagId);
  }

  private async resolveDebugLevelId(params: {
    presetId?: string;
    debugLevelId?: string;
    customLevels?: CategoryLevels;
  }): Promise<string> {
    if (params.debugLevelId) return params.debugLevelId;
    if (params.customLevels) return this.traceFlags.upsertCustomDebugLevel(params.customLevels);
    const preset = findPreset(params.presetId ?? '');
    if (!preset) throw new Error(`Unknown debug level preset: ${params.presetId}`);
    return this.traceFlags.upsertPresetDebugLevel(preset);
  }

  // ── Entities ────────────────────────────────────────────────────────────

  async currentUser(): Promise<TraceEntity | null> {
    return this.entities.currentUser();
  }

  async systemUsers(): Promise<TraceEntity[]> {
    return this.entities.systemUsers();
  }

  async searchEntities(term: string, kind: 'user' | 'apex'): Promise<TraceEntity[]> {
    return kind === 'apex'
      ? this.entities.searchApexEntities(term)
      : this.entities.searchUsers(term);
  }

  isConnected(): boolean {
    return this.connectionManager.isConnected;
  }
}

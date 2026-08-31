// TraceFlag + DebugLevel management through the Tooling API.
//
// Two Salesforce rules shape everything here:
//   1. ExpirationDate must be less than StartDate + 24 h.
//   2. Only one trace flag per traced entity can be active at a time — so
//      "start tracing" is an upsert (PATCH the existing flag, else POST), never
//      a blind insert.
// Going through the API (rather than Setup) is also the only way to trace
// system users such as Automated Process.
import type {
  CategoryLevels,
  DebugLevelPreset,
  TraceEntity,
  TraceFlagInfo,
  TraceLogType,
} from '../types';
import { presetDeveloperName } from '../debugLevelPresets';
import { soqlEscape, ToolingRest } from './ToolingRest';

export const MAX_TRACE_MS = 24 * 60 * 60 * 1000;

interface RawTraceFlag extends Record<string, unknown> {
  Id: string;
  TracedEntityId: string;
  DebugLevelId: string;
  DebugLevel?: { DeveloperName?: string } | null;
  LogType: string;
  StartDate: string;
  ExpirationDate: string;
}

export class TraceFlagApi {
  constructor(private readonly rest: ToolingRest) {}

  // ── Debug levels ────────────────────────────────────────────────────────

  /** Create or update the `ForceCockpit_*` DebugLevel backing a preset; resolves with its id. */
  async upsertPresetDebugLevel(preset: DebugLevelPreset): Promise<string> {
    const developerName = presetDeveloperName(preset);
    const existing = await this.rest.query<{ Id: string }>(
      `SELECT Id FROM DebugLevel WHERE DeveloperName = '${soqlEscape(developerName)}' LIMIT 1`,
    );
    if (existing.length > 0) {
      // Keep the record in sync in case the preset definition changed.
      await this.rest.update('DebugLevel', existing[0].Id, { ...preset.levels });
      return existing[0].Id;
    }
    return this.rest.create('DebugLevel', {
      DeveloperName: developerName,
      MasterLabel: `Force Cockpit — ${preset.label}`,
      ...preset.levels,
    });
  }

  /** Create or update an ad-hoc DebugLevel for custom category levels. */
  async upsertCustomDebugLevel(levels: CategoryLevels): Promise<string> {
    const developerName = 'ForceCockpit_Custom';
    const existing = await this.rest.query<{ Id: string }>(
      `SELECT Id FROM DebugLevel WHERE DeveloperName = '${developerName}' LIMIT 1`,
    );
    if (existing.length > 0) {
      await this.rest.update('DebugLevel', existing[0].Id, { ...levels });
      return existing[0].Id;
    }
    return this.rest.create('DebugLevel', {
      DeveloperName: developerName,
      MasterLabel: 'Force Cockpit — Custom',
      ...levels,
    });
  }

  // ── Trace flags ─────────────────────────────────────────────────────────

  /** Flags that have not expired yet, resolved to entity + debug level names. */
  async listActive(): Promise<TraceFlagInfo[]> {
    // SOQL datetime literals are unquoted and safest without milliseconds.
    const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const records = await this.rest.query<RawTraceFlag>(
      'SELECT Id, TracedEntityId, DebugLevelId, DebugLevel.DeveloperName, LogType, StartDate, ' +
        `ExpirationDate FROM TraceFlag WHERE ExpirationDate > ${nowIso} ORDER BY ExpirationDate DESC`,
    );
    if (records.length === 0) return [];

    const names = await this.resolveEntityNames(records.map((r) => r.TracedEntityId));
    return records.map((r) => {
      const resolved = names.get(r.TracedEntityId);
      return {
        id: r.Id,
        tracedEntityId: r.TracedEntityId,
        entityName: resolved?.name ?? r.TracedEntityId,
        entityKind: resolved?.kind ?? 'user',
        logType: r.LogType as TraceLogType,
        debugLevelId: r.DebugLevelId,
        debugLevelName: r.DebugLevel?.DeveloperName ?? '',
        startDate: r.StartDate,
        expirationDate: r.ExpirationDate,
      };
    });
  }

  /**
   * Start (or restart) tracing an entity. Because only one flag per entity can
   * be active, an existing flag for the same entity is PATCHed rather than
   * duplicated. `durationMs` is clamped to the 24 h platform maximum.
   */
  async upsertForEntity(params: {
    entityId: string;
    logType: TraceLogType;
    debugLevelId: string;
    durationMs: number;
  }): Promise<{ id: string; expirationDate: string; replaced: boolean }> {
    const start = new Date();
    const duration = Math.min(Math.max(params.durationMs, 60_000), MAX_TRACE_MS - 60_000);
    const expiration = new Date(start.getTime() + duration);
    const startDate = start.toISOString();
    const expirationDate = expiration.toISOString();

    const existing = await this.rest.query<{ Id: string }>(
      `SELECT Id FROM TraceFlag WHERE TracedEntityId = '${soqlEscape(params.entityId)}' ` +
        `AND LogType = '${params.logType}' ORDER BY ExpirationDate DESC LIMIT 1`,
    );

    if (existing.length > 0) {
      await this.rest.update('TraceFlag', existing[0].Id, {
        DebugLevelId: params.debugLevelId,
        StartDate: startDate,
        ExpirationDate: expirationDate,
      });
      return { id: existing[0].Id, expirationDate, replaced: true };
    }

    const id = await this.rest.create('TraceFlag', {
      TracedEntityId: params.entityId,
      DebugLevelId: params.debugLevelId,
      LogType: params.logType,
      StartDate: startDate,
      ExpirationDate: expirationDate,
    });
    return { id, expirationDate, replaced: false };
  }

  /** Push an existing flag's expiry out, still respecting the 24 h window from now. */
  async extend(flagId: string, durationMs: number): Promise<string> {
    const duration = Math.min(Math.max(durationMs, 60_000), MAX_TRACE_MS - 60_000);
    const expirationDate = new Date(Date.now() + duration).toISOString();
    await this.rest.update('TraceFlag', flagId, { ExpirationDate: expirationDate });
    return expirationDate;
  }

  async remove(flagId: string): Promise<void> {
    await this.rest.remove('TraceFlag', flagId);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  /** Map traced-entity ids to a display name, across users, classes and triggers. */
  private async resolveEntityNames(
    ids: string[],
  ): Promise<Map<string, { name: string; kind: TraceEntity['kind'] }>> {
    const unique = [...new Set(ids)];
    const out = new Map<string, { name: string; kind: TraceEntity['kind'] }>();
    const byPrefix = (prefix: string) => unique.filter((id) => id.startsWith(prefix));
    const inList = (values: string[]) => values.map((v) => `'${soqlEscape(v)}'`).join(', ');

    const userIds = byPrefix('005');
    if (userIds.length) {
      // Standard Data API: the Tooling User object is a cut-down projection.
      const users = await this.rest.queryData<{ Id: string; Name: string }>(
        `SELECT Id, Name FROM User WHERE Id IN (${inList(userIds)})`,
      );
      for (const u of users) out.set(u.Id, { name: u.Name, kind: 'user' });
    }

    const classIds = byPrefix('01p');
    if (classIds.length) {
      const classes = await this.rest.query<{ Id: string; Name: string }>(
        `SELECT Id, Name FROM ApexClass WHERE Id IN (${inList(classIds)})`,
      );
      for (const c of classes) out.set(c.Id, { name: c.Name, kind: 'apexClass' });
    }

    const triggerIds = byPrefix('01q');
    if (triggerIds.length) {
      const triggers = await this.rest.query<{ Id: string; Name: string }>(
        `SELECT Id, Name FROM ApexTrigger WHERE Id IN (${inList(triggerIds)})`,
      );
      for (const t of triggers) out.set(t.Id, { name: t.Name, kind: 'apexTrigger' });
    }

    return out;
  }
}

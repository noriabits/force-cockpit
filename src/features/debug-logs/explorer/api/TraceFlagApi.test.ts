import { describe, expect, it, vi } from 'vitest';
import { MAX_TRACE_MS, TraceFlagApi } from './TraceFlagApi';
import type { ToolingRest } from './ToolingRest';
import { findPreset } from '../debugLevelPresets';

/**
 * A ToolingRest stub whose query results are queued in call order. `query`
 * (Tooling) and `queryData` (standard Data API) share one queue so tests can
 * express the exact call sequence.
 */
function makeRest(queryResults: unknown[][] = []) {
  const queue = [...queryResults];
  const next = async () => queue.shift() ?? [];
  return {
    query: vi.fn(next),
    queryData: vi.fn(next),
    create: vi.fn(async () => 'newId'),
    update: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    getText: vi.fn(async () => ''),
  };
}

function api(rest: ReturnType<typeof makeRest>) {
  return new TraceFlagApi(rest as unknown as ToolingRest);
}

describe('upsertForEntity', () => {
  it('creates a flag when the entity has none', async () => {
    const rest = makeRest([[]]);
    const result = await api(rest).upsertForEntity({
      entityId: '005xx',
      logType: 'USER_DEBUG',
      debugLevelId: '7dl1',
      durationMs: 30 * 60 * 1000,
    });

    expect(rest.create).toHaveBeenCalledTimes(1);
    const [sobject, body] = rest.create.mock.calls[0] as [string, Record<string, unknown>];
    expect(sobject).toBe('TraceFlag');
    expect(body.TracedEntityId).toBe('005xx');
    expect(body.LogType).toBe('USER_DEBUG');
    expect(result.replaced).toBe(false);
  });

  it('updates the existing flag instead of adding a second one', async () => {
    // Salesforce allows only one active trace flag per traced entity.
    const rest = makeRest([[{ Id: '7tf1' }]]);
    const result = await api(rest).upsertForEntity({
      entityId: '005xx',
      logType: 'USER_DEBUG',
      debugLevelId: '7dl1',
      durationMs: 60 * 60 * 1000,
    });

    expect(rest.create).not.toHaveBeenCalled();
    expect(rest.update).toHaveBeenCalledWith('TraceFlag', '7tf1', expect.any(Object));
    expect(result.replaced).toBe(true);
    expect(result.id).toBe('7tf1');
  });

  it('clamps the expiration to under the 24 hour platform maximum', async () => {
    const rest = makeRest([[]]);
    const result = await api(rest).upsertForEntity({
      entityId: '005xx',
      logType: 'USER_DEBUG',
      debugLevelId: '7dl1',
      durationMs: 48 * 60 * 60 * 1000,
    });

    const body = rest.create.mock.calls[0][1] as Record<string, string>;
    const window = new Date(result.expirationDate).getTime() - new Date(body.StartDate).getTime();
    expect(window).toBeLessThan(MAX_TRACE_MS);
    expect(window).toBeGreaterThan(MAX_TRACE_MS - 2 * 60_000);
  });

  it('never asks for a window shorter than a minute', async () => {
    const rest = makeRest([[]]);
    const result = await api(rest).upsertForEntity({
      entityId: '005xx',
      logType: 'USER_DEBUG',
      debugLevelId: '7dl1',
      durationMs: 1,
    });
    const body = rest.create.mock.calls[0][1] as Record<string, string>;
    const window = new Date(result.expirationDate).getTime() - new Date(body.StartDate).getTime();
    expect(window).toBe(60_000);
  });
});

describe('upsertPresetDebugLevel', () => {
  it('creates the ForceCockpit_* DebugLevel the first time', async () => {
    const rest = makeRest([[]]);
    const id = await api(rest).upsertPresetDebugLevel(findPreset('balanced')!);
    expect(id).toBe('newId');
    const body = rest.create.mock.calls[0][1] as Record<string, string>;
    expect(body.DeveloperName).toBe('ForceCockpit_Balanced');
    expect(body.ApexCode).toBe('DEBUG');
  });

  it('re-syncs an existing record rather than creating a duplicate', async () => {
    const rest = makeRest([[{ Id: '7dl9' }]]);
    const id = await api(rest).upsertPresetDebugLevel(findPreset('deep-trace')!);
    expect(id).toBe('7dl9');
    expect(rest.create).not.toHaveBeenCalled();
    expect(rest.update).toHaveBeenCalledWith(
      'DebugLevel',
      '7dl9',
      expect.objectContaining({ ApexCode: 'FINEST' }),
    );
  });
});

describe('extend', () => {
  it('pushes the expiry out from now, capped at the maximum window', async () => {
    const rest = makeRest();
    const before = Date.now();
    const expiration = await api(rest).extend('7tf1', 48 * 60 * 60 * 1000);
    const window = new Date(expiration).getTime() - before;
    expect(window).toBeLessThan(MAX_TRACE_MS);
    expect(rest.update).toHaveBeenCalledWith('TraceFlag', '7tf1', {
      ExpirationDate: expiration,
    });
  });
});

describe('listActive', () => {
  it('resolves traced-entity ids to names by key prefix', async () => {
    const rest = makeRest([
      [
        {
          Id: '7tf1',
          TracedEntityId: '005aaa',
          DebugLevelId: '7dl1',
          DebugLevel: { DeveloperName: 'ForceCockpit_Balanced' },
          LogType: 'USER_DEBUG',
          StartDate: '2026-07-26T09:00:00.000Z',
          ExpirationDate: '2099-07-26T09:00:00.000Z',
        },
        {
          Id: '7tf2',
          TracedEntityId: '01paaa',
          DebugLevelId: '7dl1',
          DebugLevel: { DeveloperName: 'ForceCockpit_DeepTrace' },
          LogType: 'CLASS_TRACING',
          StartDate: '2026-07-26T09:00:00.000Z',
          ExpirationDate: '2099-07-26T09:00:00.000Z',
        },
      ],
      [{ Id: '005aaa', Name: 'Automated Process' }],
      [{ Id: '01paaa', Name: 'OrderService' }],
    ]);

    const flags = await api(rest).listActive();
    expect(flags).toHaveLength(2);
    expect(flags[0]).toMatchObject({ entityName: 'Automated Process', entityKind: 'user' });
    expect(flags[1]).toMatchObject({ entityName: 'OrderService', entityKind: 'apexClass' });
    // Users must be read through the standard Data API — the Tooling User
    // object has no UserType/IsActive and rejects those columns.
    expect(rest.queryData).toHaveBeenCalledWith(expect.stringContaining('FROM User'));
    expect(rest.query).not.toHaveBeenCalledWith(expect.stringContaining('FROM User'));
  });

  it('queries active flags with an unquoted, millisecond-free datetime literal', async () => {
    const rest = makeRest([[]]);
    await api(rest).listActive();
    const soql = rest.query.mock.calls[0][0] as string;
    expect(soql).toMatch(/ExpirationDate > \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
  });

  it('skips the name lookups when there are no flags', async () => {
    const rest = makeRest([[]]);
    expect(await api(rest).listActive()).toEqual([]);
    expect(rest.query).toHaveBeenCalledTimes(1);
  });
});

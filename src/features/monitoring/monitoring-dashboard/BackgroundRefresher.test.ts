import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const showWarningMessage = vi.fn();
vi.mock('vscode', () => ({
  window: { showWarningMessage },
}));

type BackgroundRefresherModule = typeof import('./BackgroundRefresher');
type NotificationsModule = typeof import('./notifications');
type MonitoringConfig = import('./MonitoringDashboardService').MonitoringConfig;

function baseConfig(overrides: Partial<MonitoringConfig> = {}): MonitoringConfig {
  return {
    id: 'cat/chart',
    folder: 'cat',
    name: 'Chart',
    description: '',
    soql: 'SELECT Id FROM Account',
    labelField: 'Id',
    valueFields: [{ field: 'Cnt', label: 'Count' }],
    chartType: 'bar',
    refreshInterval: 30,
    ...overrides,
  };
}

function makeMemento() {
  const store: Record<string, unknown> = {};
  return {
    get: vi.fn((key: string, fallback: unknown) => store[key] ?? fallback),
    update: vi.fn((key: string, value: unknown) => {
      store[key] = value;
      return Promise.resolve();
    }),
  };
}

describe('hasNotifications', () => {
  it('returns true when any value field has a threshold', async () => {
    const { hasNotifications } =
      (await import('./BackgroundRefresher')) as BackgroundRefresherModule;
    expect(
      hasNotifications(baseConfig({ valueFields: [{ field: 'A', label: 'A', threshold: 10 }] })),
    ).toBe(true);
  });

  it('returns true when notifyOnIncrease is set', async () => {
    const { hasNotifications } =
      (await import('./BackgroundRefresher')) as BackgroundRefresherModule;
    expect(hasNotifications(baseConfig({ notifyOnIncrease: true }))).toBe(true);
  });

  it('returns false when neither thresholds nor notifyOnIncrease are set', async () => {
    const { hasNotifications } =
      (await import('./BackgroundRefresher')) as BackgroundRefresherModule;
    expect(hasNotifications(baseConfig())).toBe(false);
  });
});

describe('BackgroundRefresher', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    showWarningMessage.mockReset();
    const notifications = (await import('./notifications')) as NotificationsModule;
    notifications.__resetNotificationStateForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeService(overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}) {
    return {
      runQuery:
        overrides.runQuery ??
        vi.fn().mockResolvedValue({ datasets: [{ data: [0] }], totalRows: 0 }),
      runTableQuery:
        overrides.runTableQuery ?? vi.fn().mockResolvedValue({ rows: [], totalRows: 0 }),
    };
  }

  async function makeRefresher(
    opts: {
      service?: ReturnType<typeof makeService>;
      isConnected?: boolean;
      postToWebview?: ReturnType<typeof vi.fn>;
      outputChannel?: { appendLine: ReturnType<typeof vi.fn> };
    } = {},
  ) {
    const { BackgroundRefresher } =
      (await import('./BackgroundRefresher')) as BackgroundRefresherModule;
    const service = opts.service ?? makeService();
    const cm = { isConnected: opts.isConnected ?? true } as any;
    const postToWebview = opts.postToWebview ?? vi.fn();
    const refresher = new BackgroundRefresher({
      service: service as any,
      connectionManager: cm,
      workspaceState: makeMemento() as any,
      postToWebview,
      outputChannel: opts.outputChannel as any,
    });
    return { refresher, service, cm, postToWebview };
  }

  it('schedules timers only for notification-enabled configs', async () => {
    const { refresher } = await makeRefresher();
    refresher.start([
      baseConfig({ id: 'a', valueFields: [{ field: 'V', label: 'V', threshold: 10 }] }),
      baseConfig({ id: 'b', notifyOnIncrease: true }),
      baseConfig({ id: 'c' }),
      baseConfig({ id: 'd', refreshInterval: 0 }),
    ]);
    expect(refresher.scheduledIds.sort()).toEqual(['a', 'b']);
    refresher.stop();
  });

  it('skips __preview__ configs even when notification flags are set', async () => {
    const { refresher } = await makeRefresher();
    refresher.start([baseConfig({ id: '__preview__/x', notifyOnIncrease: true })]);
    expect(refresher.scheduledIds).toEqual([]);
  });

  it('enforces a 10s minimum interval', async () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    const { refresher } = await makeRefresher();
    refresher.start([baseConfig({ id: 'a', refreshInterval: 1, notifyOnIncrease: true })]);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 10_000);
    refresher.stop();
    setIntervalSpy.mockRestore();
  });

  it('bails when not connected — does not call service', async () => {
    const service = makeService();
    const { refresher } = await makeRefresher({ service, isConnected: false });
    refresher.start([baseConfig({ id: 'a', refreshInterval: 30, notifyOnIncrease: true })]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(service.runQuery).not.toHaveBeenCalled();
    refresher.stop();
  });

  it('on tick: runs query, fires threshold notification, and posts to webview', async () => {
    showWarningMessage.mockResolvedValue(undefined);
    const service = makeService({
      runQuery: vi.fn().mockResolvedValue({ datasets: [{ data: [200] }], totalRows: 1 }),
    });
    const postToWebview = vi.fn();
    const { refresher } = await makeRefresher({ service, postToWebview });
    refresher.start([
      baseConfig({
        id: 'cat/chart',
        valueFields: [{ field: 'Cnt', label: 'Count', threshold: 100 }],
      }),
    ]);
    await vi.advanceTimersByTimeAsync(30_000);
    // Flush microtasks queued by the awaited service.runQuery promise chain
    await Promise.resolve();
    await Promise.resolve();
    expect(service.runQuery).toHaveBeenCalledOnce();
    expect(showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('threshold of 100'),
      'Snooze 1h',
      'Snooze for today',
    );
    expect(postToWebview).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'monitoringBackgroundRefreshResult',
        data: expect.objectContaining({ configId: 'cat/chart', chartType: 'bar' }),
      }),
    );
    refresher.stop();
  });

  it('uses runTableQuery for table chartType', async () => {
    showWarningMessage.mockResolvedValue(undefined);
    const service = makeService({
      runTableQuery: vi.fn().mockResolvedValue({ rows: [['x', '50']], totalRows: 1 }),
    });
    const { refresher } = await makeRefresher({ service });
    refresher.start([
      baseConfig({
        id: 'cat/tbl',
        chartType: 'table',
        valueFields: [{ field: 'Cnt', label: 'Count', threshold: 10 }],
      }),
    ]);
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(service.runTableQuery).toHaveBeenCalledOnce();
    expect(showWarningMessage).toHaveBeenCalled();
    refresher.stop();
  });

  it('restart replaces previous timers — no leaks', async () => {
    const { refresher } = await makeRefresher();
    refresher.start([baseConfig({ id: 'a', notifyOnIncrease: true })]);
    refresher.restart([baseConfig({ id: 'b', notifyOnIncrease: true })]);
    expect(refresher.scheduledIds).toEqual(['b']);
    refresher.stop();
  });

  it('stop clears all timers', async () => {
    const { refresher } = await makeRefresher();
    refresher.start([
      baseConfig({ id: 'a', notifyOnIncrease: true }),
      baseConfig({ id: 'b', notifyOnIncrease: true }),
    ]);
    refresher.stop();
    expect(refresher.scheduledIds).toEqual([]);
    expect(refresher.running).toBe(false);
  });

  it('swallows query errors without breaking the timer loop', async () => {
    const service = makeService({
      runQuery: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const outputChannel = { appendLine: vi.fn() };
    const { refresher } = await makeRefresher({ service, outputChannel });
    refresher.start([baseConfig({ id: 'a', notifyOnIncrease: true })]);
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(outputChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining('background refresh failed'),
    );
    refresher.stop();
  });
});

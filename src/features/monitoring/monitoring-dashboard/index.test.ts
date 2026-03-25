import { beforeEach, describe, expect, it, vi } from 'vitest';

const showWarningMessage = vi.fn();
vi.mock('vscode', () => ({
  window: { showWarningMessage },
}));

vi.mock('./MonitoringDashboardService', () => ({
  MonitoringDashboardService: vi.fn().mockImplementation(function () {
    return {
      loadConfigs: vi.fn(),
      runQuery: vi.fn(),
      runTableQuery: vi.fn(),
      saveConfig: vi.fn(),
    };
  }),
}));

function makeMemento(initial: Record<string, unknown> = {}): {
  get: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
} {
  const store = { ...initial };
  return {
    get: vi.fn((key: string, fallback: unknown) => store[key] ?? fallback),
    update: vi.fn((key: string, value: unknown) => {
      store[key] = value;
      return Promise.resolve();
    }),
  };
}

describe('monitoring snooze persistence', () => {
  beforeEach(() => {
    vi.resetModules();
    showWarningMessage.mockReset();
  });

  async function loadFactory() {
    const mod = await import('./index');
    return mod.createMonitoringDashboardFeature;
  }

  it('loads persisted snoozes and suppresses notifications for snoozed thresholds', async () => {
    const futureTime = Date.now() + 3_600_000;
    const memento = makeMemento({
      'monitoring.notificationCooldowns': { 'chart1:0': futureTime },
    });
    const createFeature = await loadFactory();
    const factory = createFeature({
      builtInPath: '',
      userPath: '',
      privatePath: '',
      workspaceState: memento as any,
    });
    const cm = { query: vi.fn() } as any;
    const feature = factory(cm);

    const handler = feature.routes['runMonitoringQuery'].handler;
    const mockService = (await import('./MonitoringDashboardService')).MonitoringDashboardService;
    const serviceInstance = (mockService as any).mock.results.at(-1).value;
    serviceInstance.runQuery.mockResolvedValue({
      labels: ['A'],
      datasets: [{ data: [200] }],
    });

    await handler({
      configId: 'chart1',
      configName: 'Chart 1',
      soql: 'SELECT ...',
      labelField: 'Field',
      valueFields: [{ field: 'Cnt', label: 'Count', threshold: 100 }],
    });

    // Notification suppressed because chart1:0 is snoozed
    expect(showWarningMessage).not.toHaveBeenCalled();
  });

  it('prunes expired entries on load', async () => {
    showWarningMessage.mockResolvedValue(undefined);
    const expiredTime = Date.now() - 1000;
    const futureTime = Date.now() + 3_600_000;
    const memento = makeMemento({
      'monitoring.notificationCooldowns': {
        'expired:0': expiredTime,
        'active:0': futureTime,
      },
    });
    const createFeature = await loadFactory();
    const factory = createFeature({
      builtInPath: '',
      userPath: '',
      privatePath: '',
      workspaceState: memento as any,
    });
    const cm = { query: vi.fn() } as any;
    const feature = factory(cm);

    // Trigger a query for the "expired" config — should NOT be suppressed
    const handler = feature.routes['runMonitoringQuery'].handler;
    const mockService = (await import('./MonitoringDashboardService')).MonitoringDashboardService;
    const serviceInstance = (mockService as any).mock.results.at(-1).value;
    serviceInstance.runQuery.mockResolvedValue({
      labels: ['A'],
      datasets: [{ data: [200] }],
    });

    await handler({
      configId: 'expired',
      configName: 'Expired Chart',
      soql: 'SELECT ...',
      labelField: 'Field',
      valueFields: [{ field: 'Cnt', label: 'Count', threshold: 100 }],
    });

    // Expired entry was pruned, so notification fires
    expect(showWarningMessage).toHaveBeenCalled();
  });

  it('persists snooze to workspaceState when user clicks Snooze 1h', async () => {
    showWarningMessage.mockResolvedValue('Snooze 1h');

    const memento = makeMemento();
    const createFeature = await loadFactory();
    const factory = createFeature({
      builtInPath: '',
      userPath: '',
      privatePath: '',
      workspaceState: memento as any,
    });
    const cm = { query: vi.fn() } as any;
    const feature = factory(cm);

    const handler = feature.routes['runMonitoringQuery'].handler;
    const mockService = (await import('./MonitoringDashboardService')).MonitoringDashboardService;
    const serviceInstance = (mockService as any).mock.results.at(-1).value;
    serviceInstance.runQuery.mockResolvedValue({
      labels: ['A'],
      datasets: [{ data: [200] }],
    });

    await handler({
      configId: 'chart1',
      configName: 'Chart 1',
      soql: 'SELECT ...',
      labelField: 'Field',
      valueFields: [{ field: 'Cnt', label: 'Count', threshold: 100 }],
    });

    // Wait for the .then() callback to complete
    await vi.waitFor(() => {
      expect(memento.update).toHaveBeenCalledWith(
        'monitoring.notificationCooldowns',
        expect.objectContaining({ 'chart1:0': expect.any(Number) }),
      );
    });

    const savedData = memento.update.mock.calls[0][1] as Record<string, number>;
    const snoozeUntil = savedData['chart1:0'];
    // Should be approximately 1 hour from now
    expect(snoozeUntil).toBeGreaterThan(Date.now() + 3_500_000);
    expect(snoozeUntil).toBeLessThanOrEqual(Date.now() + 3_600_000 + 1000);
  });

  it('persists snooze to workspaceState when user clicks Snooze for today', async () => {
    showWarningMessage.mockResolvedValue('Snooze for today');

    const memento = makeMemento();
    const createFeature = await loadFactory();
    const factory = createFeature({
      builtInPath: '',
      userPath: '',
      privatePath: '',
      workspaceState: memento as any,
    });
    const cm = { query: vi.fn() } as any;
    const feature = factory(cm);

    const handler = feature.routes['runMonitoringQuery'].handler;
    const mockService = (await import('./MonitoringDashboardService')).MonitoringDashboardService;
    const serviceInstance = (mockService as any).mock.results.at(-1).value;
    serviceInstance.runQuery.mockResolvedValue({
      labels: ['A'],
      datasets: [{ data: [200] }],
    });

    await handler({
      configId: 'chart1',
      configName: 'Chart 1',
      soql: 'SELECT ...',
      labelField: 'Field',
      valueFields: [{ field: 'Cnt', label: 'Count', threshold: 100 }],
    });

    await vi.waitFor(() => {
      expect(memento.update).toHaveBeenCalled();
    });

    const savedData = memento.update.mock.calls[0][1] as Record<string, number>;
    const snoozeUntil = savedData['chart1:0'];
    // Should be midnight tonight
    const midnight = new Date();
    midnight.setHours(24, 0, 0, 0);
    expect(snoozeUntil).toBe(midnight.getTime());
  });

  it('prunes cooldowns when threshold is removed on save', async () => {
    showWarningMessage.mockResolvedValue('Snooze 1h');

    const futureTime = Date.now() + 3_600_000;
    const memento = makeMemento({
      'monitoring.notificationCooldowns': { 'chart1:0': futureTime, 'other:0': futureTime },
    });
    const createFeature = await loadFactory();
    const factory = createFeature({
      builtInPath: '',
      userPath: '',
      privatePath: '',
      workspaceState: memento as any,
    });
    const cm = { query: vi.fn() } as any;
    const feature = factory(cm);

    const mockService = (await import('./MonitoringDashboardService')).MonitoringDashboardService;
    const serviceInstance = (mockService as any).mock.results.at(-1).value;
    // saveConfig returns the saved config (threshold removed)
    serviceInstance.saveConfig.mockReturnValue({
      id: 'chart1',
      name: 'Chart 1',
      valueFields: [{ field: 'Cnt', label: 'Count' }], // no threshold
    });

    const saveHandler = feature.routes['saveMonitoringConfig'].handler;
    await saveHandler({ config: { id: 'chart1' }, isPrivate: false });

    // chart1:0 should be pruned, other:0 should remain
    const savedData = memento.update.mock.calls.at(-1)?.[1] as Record<string, number>;
    expect(savedData).not.toHaveProperty('chart1:0');
    expect(savedData).toHaveProperty('other:0');
  });

  it('prunes cooldowns for out-of-bounds field indexes on save', async () => {
    const futureTime = Date.now() + 3_600_000;
    const memento = makeMemento({
      'monitoring.notificationCooldowns': {
        'chart1:0': futureTime,
        'chart1:1': futureTime,
        'chart1:2': futureTime,
      },
    });
    const createFeature = await loadFactory();
    const factory = createFeature({
      builtInPath: '',
      userPath: '',
      privatePath: '',
      workspaceState: memento as any,
    });
    const cm = { query: vi.fn() } as any;
    const feature = factory(cm);

    const mockService = (await import('./MonitoringDashboardService')).MonitoringDashboardService;
    const serviceInstance = (mockService as any).mock.results.at(-1).value;
    // Save with only 1 valueField (had 3 before), keeping threshold on field 0
    serviceInstance.saveConfig.mockReturnValue({
      id: 'chart1',
      name: 'Chart 1',
      valueFields: [{ field: 'Cnt', label: 'Count', threshold: 100 }],
    });

    const saveHandler = feature.routes['saveMonitoringConfig'].handler;
    await saveHandler({ config: { id: 'chart1' }, isPrivate: false });

    const savedData = memento.update.mock.calls.at(-1)?.[1] as Record<string, number>;
    // field 0 still has threshold — keep it
    expect(savedData).toHaveProperty('chart1:0');
    // fields 1 and 2 are out of bounds — pruned
    expect(savedData).not.toHaveProperty('chart1:1');
    expect(savedData).not.toHaveProperty('chart1:2');
  });

  it('does not persist the default 1-minute cooldown', async () => {
    // User dismisses the notification without snoozing
    showWarningMessage.mockResolvedValue(undefined);

    const memento = makeMemento();
    const createFeature = await loadFactory();
    const factory = createFeature({
      builtInPath: '',
      userPath: '',
      privatePath: '',
      workspaceState: memento as any,
    });
    const cm = { query: vi.fn() } as any;
    const feature = factory(cm);

    const handler = feature.routes['runMonitoringQuery'].handler;
    const mockService = (await import('./MonitoringDashboardService')).MonitoringDashboardService;
    const serviceInstance = (mockService as any).mock.results.at(-1).value;
    serviceInstance.runQuery.mockResolvedValue({
      labels: ['A'],
      datasets: [{ data: [200] }],
    });

    await handler({
      configId: 'chart1',
      configName: 'Chart 1',
      soql: 'SELECT ...',
      labelField: 'Field',
      valueFields: [{ field: 'Cnt', label: 'Count', threshold: 100 }],
    });

    // The default cooldown is set in the Map but should NOT be persisted
    expect(memento.update).not.toHaveBeenCalled();
  });
});

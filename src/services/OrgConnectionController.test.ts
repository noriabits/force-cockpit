import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionManager } from '../salesforce/connection';
import type { OrgDetails } from '../utils/sfCli';
import { OrgConnectionController, OrgConnectionDeps } from './OrgConnectionController';

function org(target: string): OrgDetails {
  return {
    alias: target,
    username: `${target}@example.com`,
    orgId: '00D',
    instanceUrl: 'https://example.my.salesforce.com',
    accessToken: 'tok',
  };
}

/** Mutable in-memory ConnectionManager double tracking connected state + current org. */
function makeCm(initial: { connected?: boolean; current?: OrgDetails | null } = {}) {
  let connected = initial.connected ?? false;
  let current = initial.current ?? null;
  const connect = vi.fn(async (details: OrgDetails) => {
    connected = true;
    current = details;
  });
  const disconnect = vi.fn(() => {
    connected = false;
    current = null;
  });
  const cm = {
    get isConnected() {
      return connected;
    },
    getCurrentOrg: () => current,
    connect,
    disconnect,
  } as unknown as ConnectionManager;
  return { cm, connect, disconnect };
}

function makeDeps(overrides: Partial<OrgConnectionDeps> = {}): OrgConnectionDeps {
  const { cm } = makeCm();
  return {
    connectionManager: cm,
    readTargetOrg: vi.fn().mockReturnValue('myorg'),
    getOrgDetails: vi.fn(async (t: string) => org(t)),
    refreshOrgToken: vi.fn().mockResolvedValue(undefined),
    guardBusy: vi.fn().mockResolvedValue(true),
    notifyConnecting: vi.fn(),
    showWarning: vi.fn(),
    showInfo: vi.fn(),
    log: vi.fn(),
    retryDelaysMs: [1, 1, 1],
    ...overrides,
  };
}

describe('OrgConnectionController.connectFromConfig', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('no-ops when already connected to the same org', async () => {
    const { cm, connect, disconnect } = makeCm({ connected: true, current: org('myorg') });
    const deps = makeDeps({ connectionManager: cm, readTargetOrg: () => 'myorg' });
    await new OrgConnectionController(deps).connectFromConfig();
    expect(connect).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
    expect(deps.guardBusy).not.toHaveBeenCalled();
  });

  it('force reconnects even when already connected to the same org', async () => {
    const { cm, connect, disconnect } = makeCm({ connected: true, current: org('myorg') });
    const deps = makeDeps({ connectionManager: cm, readTargetOrg: () => 'myorg' });
    await new OrgConnectionController(deps).connectFromConfig({ force: true });
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('target removed while connected → guardBusy asked, then disconnects', async () => {
    const { cm, disconnect } = makeCm({ connected: true, current: org('myorg') });
    const deps = makeDeps({ connectionManager: cm, readTargetOrg: () => undefined });
    await new OrgConnectionController(deps).connectFromConfig();
    expect(deps.guardBusy).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('target removed but guard declined → no disconnect', async () => {
    const { cm, disconnect } = makeCm({ connected: true, current: org('myorg') });
    const deps = makeDeps({
      connectionManager: cm,
      readTargetOrg: () => undefined,
      guardBusy: vi.fn().mockResolvedValue(false),
    });
    await new OrgConnectionController(deps).connectFromConfig();
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('no target + not connected + force → showInfo', async () => {
    const deps = makeDeps({ readTargetOrg: () => undefined });
    await new OrgConnectionController(deps).connectFromConfig({ force: true });
    expect(deps.showInfo).toHaveBeenCalledTimes(1);
  });

  it('read error is silent normally', async () => {
    const deps = makeDeps({
      readTargetOrg: () => {
        throw new Error('boom');
      },
    });
    await new OrgConnectionController(deps).connectFromConfig();
    expect(deps.showWarning).not.toHaveBeenCalled();
  });

  it('read error shows a warning when forced', async () => {
    const deps = makeDeps({
      readTargetOrg: () => {
        throw new Error('boom');
      },
    });
    await new OrgConnectionController(deps).connectFromConfig({ force: true });
    expect(deps.showWarning).toHaveBeenCalledTimes(1);
    expect((deps.showWarning as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('boom');
  });

  it('version race: a newer connectFromConfig invalidates the first (no double connect, no warning)', async () => {
    const { cm, connect } = makeCm();
    let resolveFirst!: (v: OrgDetails) => void;
    const getOrgDetails = vi
      .fn()
      .mockImplementationOnce(() => new Promise<OrgDetails>((resolve) => (resolveFirst = resolve)))
      .mockImplementation(async (t: string) => org(t));
    const deps = makeDeps({ connectionManager: cm, getOrgDetails });
    const controller = new OrgConnectionController(deps);

    const first = controller.connectFromConfig();
    await Promise.resolve(); // let the first reach the awaited getOrgDetails
    const second = controller.connectFromConfig();
    await second;
    resolveFirst(org('myorg'));
    await first;

    expect(connect).toHaveBeenCalledTimes(1);
    expect(deps.showWarning).not.toHaveBeenCalled();
  });

  it('retries: fails twice then succeeds (3 getOrgDetails, 2 refreshOrgToken, no warning)', async () => {
    const getOrgDetails = vi
      .fn()
      .mockRejectedValueOnce(new Error('1'))
      .mockRejectedValueOnce(new Error('2'))
      .mockImplementation(async (t: string) => org(t));
    const deps = makeDeps({ getOrgDetails });
    await new OrgConnectionController(deps).connectFromConfig();
    expect(getOrgDetails).toHaveBeenCalledTimes(3);
    expect(deps.refreshOrgToken).toHaveBeenCalledTimes(2);
    expect(deps.showWarning).not.toHaveBeenCalled();
  });

  it('all four attempts fail → exactly one warning with the last error', async () => {
    const getOrgDetails = vi
      .fn()
      .mockRejectedValueOnce(new Error('a'))
      .mockRejectedValueOnce(new Error('b'))
      .mockRejectedValueOnce(new Error('c'))
      .mockRejectedValue(new Error('final'));
    const deps = makeDeps({ getOrgDetails });
    await new OrgConnectionController(deps).connectFromConfig();
    expect(getOrgDetails).toHaveBeenCalledTimes(4);
    expect(deps.refreshOrgToken).toHaveBeenCalledTimes(3);
    expect(deps.showWarning).toHaveBeenCalledTimes(1);
    expect((deps.showWarning as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('final');
  });

  it('notifyConnecting fires once, before the first connect attempt', async () => {
    const deps = makeDeps();
    await new OrgConnectionController(deps).connectFromConfig();
    expect(deps.notifyConnecting).toHaveBeenCalledTimes(1);
    const notifyOrder = (deps.notifyConnecting as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    const getDetailsOrder = (deps.getOrgDetails as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    expect(notifyOrder).toBeLessThan(getDetailsOrder);
  });
});

describe('OrgConnectionController.scheduleConnect', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('coalesces rapid calls within the debounce window into one connectFromConfig', () => {
    vi.useFakeTimers();
    const controller = new OrgConnectionController(makeDeps({ debounceMs: 300 }));
    const spy = vi.spyOn(controller, 'connectFromConfig').mockResolvedValue();
    controller.scheduleConnect();
    controller.scheduleConnect();
    controller.scheduleConnect();
    vi.advanceTimersByTime(300);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('OrgConnectionController.handleConfigDeleted', () => {
  it('disconnects when connected', () => {
    const { cm, disconnect } = makeCm({ connected: true, current: org('myorg') });
    new OrgConnectionController(makeDeps({ connectionManager: cm })).handleConfigDeleted();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('no-ops when not connected', () => {
    const { cm, disconnect } = makeCm({ connected: false });
    new OrgConnectionController(makeDeps({ connectionManager: cm })).handleConfigDeleted();
    expect(disconnect).not.toHaveBeenCalled();
  });
});

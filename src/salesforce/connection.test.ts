import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgDetails } from '../utils/sfCli';

// Controllable jsforce.Connection mock. `identity()` either resolves
// immediately (autoResolveIdentity) or parks a deferred we resolve by hand
// to interleave concurrent connect() calls and exercise the version races.
let autoResolveIdentity = true;
const identityDeferreds: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];
let connectionConstructorCount = 0;

vi.mock('@jsforce/jsforce-node', () => ({
  Connection: class {
    instanceUrl: string;
    accessToken: string;
    version: string;
    constructor(opts: { instanceUrl: string; accessToken: string; version: string }) {
      connectionConstructorCount++;
      this.instanceUrl = opts.instanceUrl;
      this.accessToken = opts.accessToken;
      this.version = opts.version;
    }
    identity() {
      if (autoResolveIdentity) return Promise.resolve({});
      return new Promise<void>((resolve, reject) =>
        identityDeferreds.push({ resolve: () => resolve(), reject }),
      );
    }
  },
}));

import { ConnectionManager } from './connection';

function org(overrides: Partial<OrgDetails> = {}): OrgDetails {
  return {
    username: 'user@example.com',
    orgId: '00D000000000000',
    instanceUrl: 'https://example.my.salesforce.com',
    accessToken: 'TOKEN',
    ...overrides,
  } as OrgDetails;
}

/** Flush enough microtasks for the parked identity().then chains to settle. */
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('ConnectionManager', () => {
  beforeEach(() => {
    autoResolveIdentity = true;
    identityDeferreds.length = 0;
    connectionConstructorCount = 0;
  });

  it('connect() establishes the connection and emits connectionChanged', async () => {
    const cm = new ConnectionManager();
    const events: Array<{ connected: boolean }> = [];
    cm.on('connectionChanged', (e) => events.push(e));

    await cm.connect(org({ alias: 'myorg' }));

    expect(cm.isConnected).toBe(true);
    expect(cm.getCurrentOrg()?.alias).toBe('myorg');
    expect(cm.connectingTarget).toBeNull();
    expect(events).toEqual([{ connected: true, org: expect.objectContaining({ alias: 'myorg' }) }]);
  });

  it('rejects a duplicate connect to the same in-flight target', async () => {
    autoResolveIdentity = false;
    const cm = new ConnectionManager();

    const first = cm.connect(org({ alias: 'a' }));
    expect(cm.connectingTarget).toBe('a');
    // Second call to the same target returns immediately without a new Connection
    await cm.connect(org({ alias: 'a' }));
    expect(connectionConstructorCount).toBe(1);

    identityDeferreds[0].resolve();
    await first;
    expect(cm.isConnected).toBe(true);
  });

  it('discards the result when disconnect() runs during an in-flight connect()', async () => {
    autoResolveIdentity = false;
    const cm = new ConnectionManager();
    const events: Array<{ connected: boolean }> = [];
    cm.on('connectionChanged', (e) => events.push(e));

    const pending = cm.connect(org({ alias: 'a' }));
    // Disconnect bumps the version, invalidating the in-flight connect
    cm.disconnect();
    identityDeferreds[0].resolve();
    await pending;
    await flush();

    expect(cm.isConnected).toBe(false);
    // Only the disconnect event fired; the stale connect did not emit connected:true
    expect(events).toEqual([{ connected: false }]);
  });

  it('a newer connect() invalidates an older in-flight connect()', async () => {
    autoResolveIdentity = false;
    const cm = new ConnectionManager();

    const firstPending = cm.connect(org({ alias: 'a' }));
    const secondPending = cm.connect(org({ alias: 'b' }));
    expect(connectionConstructorCount).toBe(2);

    // Resolve the FIRST (older) connect last — it should be discarded as stale
    identityDeferreds[1].resolve(); // b
    await secondPending;
    identityDeferreds[0].resolve(); // a
    await firstPending;
    await flush();

    expect(cm.isConnected).toBe(true);
    expect(cm.getCurrentOrg()?.alias).toBe('b');
  });

  it('disconnect() clears connection state and the org-details cache', () => {
    const cm = new ConnectionManager();
    cm.disconnect();
    expect(cm.isConnected).toBe(false);
    expect(cm.getCurrentOrg()).toBeNull();
    expect(cm.connectingTarget).toBeNull();
  });

  describe('request()', () => {
    function fakeResponse(overrides: {
      status?: number;
      statusText?: string;
      headers?: Record<string, string>;
      contentType?: string;
      json?: unknown;
      text?: string;
    }) {
      const headers = new Headers({
        'content-type': overrides.contentType ?? 'application/json',
        ...overrides.headers,
      });
      return {
        status: overrides.status ?? 200,
        statusText: overrides.statusText ?? 'OK',
        headers,
        json: vi.fn().mockResolvedValue(overrides.json ?? { ok: true }),
        text: vi.fn().mockResolvedValue(overrides.text ?? ''),
      };
    }

    it('throws when not connected', async () => {
      const cm = new ConnectionManager();
      await expect(cm.request({ method: 'GET', url: '/services/data' })).rejects.toThrow();
    });

    it('resolves relative URLs against instanceUrl and attaches the Bearer token', async () => {
      const cm = new ConnectionManager();
      await cm.connect(org());
      const fetchMock = vi.fn().mockResolvedValue(fakeResponse({}));
      vi.stubGlobal('fetch', fetchMock);

      await cm.request({ method: 'GET', url: '/services/data/v60.0/sobjects' });

      expect(fetchMock).toHaveBeenCalledWith(
        'https://example.my.salesforce.com/services/data/v60.0/sobjects',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({ Authorization: 'Bearer TOKEN' }),
        }),
      );
      vi.unstubAllGlobals();
    });

    it('leaves absolute http(s) URLs untouched', async () => {
      const cm = new ConnectionManager();
      await cm.connect(org());
      const fetchMock = vi.fn().mockResolvedValue(fakeResponse({}));
      vi.stubGlobal('fetch', fetchMock);

      await cm.request({ method: 'GET', url: 'https://other-host.example.com/x' });

      expect(fetchMock).toHaveBeenCalledWith('https://other-host.example.com/x', expect.anything());
      vi.unstubAllGlobals();
    });

    it('never lets a caller-supplied Authorization header override the real token', async () => {
      const cm = new ConnectionManager();
      await cm.connect(org());
      const fetchMock = vi.fn().mockResolvedValue(fakeResponse({}));
      vi.stubGlobal('fetch', fetchMock);

      await cm.request({
        method: 'GET',
        url: '/x',
        headers: { Authorization: 'Bearer attacker-supplied' },
      });

      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer TOKEN' }),
        }),
      );
      vi.unstubAllGlobals();
    });

    it('returns status/headers/body without throwing on a non-2xx response', async () => {
      const cm = new ConnectionManager();
      await cm.connect(org());
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(fakeResponse({ status: 404, json: { message: 'not found' } })),
      );

      const result = await cm.request({ method: 'GET', url: '/x' });

      expect(result.status).toBe(404);
      expect(result.body).toEqual({ message: 'not found' });
      vi.unstubAllGlobals();
    });

    it('parses a non-JSON content-type as text', async () => {
      const cm = new ConnectionManager();
      await cm.connect(org());
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(fakeResponse({ contentType: 'text/plain', text: 'hello' })),
      );

      const result = await cm.request({ method: 'GET', url: '/x' });

      expect(result.body).toBe('hello');
      vi.unstubAllGlobals();
    });
  });
});

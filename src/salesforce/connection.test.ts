import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgDetails } from '../utils/sfCli';

// Controllable jsforce.Connection mock. `identity()` either resolves
// immediately (autoResolveIdentity) or parks a deferred we resolve by hand
// to interleave concurrent connect() calls and exercise the version races.
let autoResolveIdentity = true;
const identityDeferreds: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];
let connectionConstructorCount = 0;
/** When set, identity() rejects with this — simulates a session jsforce cannot refresh. */
let identityError: unknown = null;
/** Runs on every identity() call — used to simulate jsforce's delegate swapping the token in. */
let onIdentity: ((conn: FakeConnection) => void) | null = null;
let identityCallCount = 0;
/** The most recently constructed connection, so tests can inspect its config. */
let lastConnection: FakeConnection | null = null;
const queryMock = vi.fn();

interface FakeConnection {
  instanceUrl: string;
  accessToken: string;
  version: string;
  oauth2?: unknown;
  refreshFn?: unknown;
}

vi.mock('@jsforce/jsforce-node', async () => {
  const { EventEmitter } = await import('events');
  return {
    Connection: class extends EventEmitter {
      instanceUrl: string;
      accessToken: string;
      version: string;
      oauth2?: unknown;
      refreshFn?: unknown;
      constructor(opts: {
        instanceUrl: string;
        accessToken: string;
        version: string;
        oauth2?: unknown;
        refreshFn?: unknown;
      }) {
        super();
        connectionConstructorCount++;
        this.instanceUrl = opts.instanceUrl;
        this.accessToken = opts.accessToken;
        this.version = opts.version;
        this.oauth2 = opts.oauth2;
        this.refreshFn = opts.refreshFn;
        lastConnection = this as unknown as FakeConnection;
      }
      identity() {
        identityCallCount++;
        if (identityError) return Promise.reject(identityError);
        onIdentity?.(this as unknown as FakeConnection);
        if (autoResolveIdentity) return Promise.resolve({});
        return new Promise<void>((resolve, reject) =>
          identityDeferreds.push({ resolve: () => resolve(), reject }),
        );
      }
      query(soql: string) {
        return queryMock(soql);
      }
    },
  };
});

// Mocking sfCli keeps @salesforce/core out of these unit tests and lets each case decide
// what the auth lookups return — including whether the org has a usable refreshFn.
const getConnectionOptionsMock = vi.fn();
const refreshOrgTokenMock = vi.fn();
const getOrgDetailsMock = vi.fn();

vi.mock('../utils/sfCli', () => ({
  getConnectionOptions: (...args: unknown[]) => getConnectionOptionsMock(...args),
  refreshOrgToken: (...args: unknown[]) => refreshOrgTokenMock(...args),
  getOrgDetails: (...args: unknown[]) => getOrgDetailsMock(...args),
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

/**
 * Flush enough microtasks for the parked identity().then chains to settle. The trailing
 * macrotask tick also lets connect()'s awaited auth lookup resolve, so the jsforce
 * Connection has actually been constructed by the time we inspect it.
 */
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe('ConnectionManager', () => {
  beforeEach(() => {
    autoResolveIdentity = true;
    identityDeferreds.length = 0;
    connectionConstructorCount = 0;
    identityError = null;
    onIdentity = null;
    identityCallCount = 0;
    lastConnection = null;
    queryMock.mockReset();
    getConnectionOptionsMock.mockReset().mockResolvedValue({
      instanceUrl: 'https://example.my.salesforce.com',
      accessToken: 'TOKEN',
      oauth2: { loginUrl: 'https://login.salesforce.com', clientId: 'PlatformCLI' },
      refreshFn: () => {},
    });
    refreshOrgTokenMock.mockReset().mockResolvedValue(undefined);
    getOrgDetailsMock.mockReset();
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
    await flush();
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
    await flush();
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
    await flush();
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

  describe('refreshable auth', () => {
    it('builds the connection from AuthInfo options so jsforce can self-refresh', async () => {
      const cm = new ConnectionManager();
      await cm.connect(org());

      expect(getConnectionOptionsMock).toHaveBeenCalledWith('user@example.com');
      expect(lastConnection?.oauth2).toEqual({
        loginUrl: 'https://login.salesforce.com',
        clientId: 'PlatformCLI',
      });
      expect(lastConnection?.refreshFn).toBeTypeOf('function');
    });

    it('falls back to the stored access token when AuthInfo options are unavailable', async () => {
      getConnectionOptionsMock.mockRejectedValue(new Error('no auth file'));
      const logged: string[] = [];
      const cm = new ConnectionManager({ log: (m) => logged.push(m) });

      await cm.connect(org({ accessToken: 'FALLBACK' }));

      expect(cm.isConnected).toBe(true);
      expect(lastConnection?.accessToken).toBe('FALLBACK');
      expect(lastConnection?.refreshFn).toBeUndefined();
      expect(logged.join('\n')).toContain('using the stored access token');
    });

    it("syncs the OrgDetails snapshot when jsforce emits 'refresh'", async () => {
      const cm = new ConnectionManager();
      await cm.connect(org());

      (lastConnection as unknown as { emit: (e: string, t: string) => void }).emit(
        'refresh',
        'RENEWED',
      );

      // buildOrgUrl() reads accessToken off this snapshot to build the frontdoor link
      expect(cm.getCurrentOrg()?.accessToken).toBe('RENEWED');
    });

    it('syncs the snapshot when the token is refreshed during connect()', async () => {
      // jsforce renews inside identity(), i.e. before _connection is assigned — too early
      // for the 'refresh' listener, which ignores connections that are not yet current.
      onIdentity = (conn) => {
        conn.accessToken = 'FRESH';
        (conn as unknown as { emit: (e: string, t: string) => void }).emit('refresh', 'FRESH');
      };
      const cm = new ConnectionManager();

      await cm.connect(org({ accessToken: 'STALE' }));

      expect(cm.getCurrentOrg()?.accessToken).toBe('FRESH');
    });

    it('does not leave the snapshot stale after a connect-time refresh', async () => {
      // Regression: ensureValidSession() cannot repair this later — the token is valid by
      // then, so it reports "nothing changed" and never rewrites the snapshot.
      onIdentity = (conn) => {
        conn.accessToken = 'FRESH';
      };
      const cm = new ConnectionManager();
      await cm.connect(org({ accessToken: 'STALE' }));

      onIdentity = null; // token is now valid; identity() succeeds without changing it
      expect(await cm.ensureValidSession()).toBe(false);
      expect(cm.getCurrentOrg()?.accessToken).toBe('FRESH');
    });

    it('snapshots the AuthInfo token when it differs from the OrgDetails one', async () => {
      getConnectionOptionsMock.mockResolvedValue({
        instanceUrl: 'https://example.my.salesforce.com',
        accessToken: 'FROM_AUTHINFO',
        refreshFn: () => {},
      });
      const cm = new ConnectionManager();

      await cm.connect(org({ accessToken: 'FROM_ORGDETAILS' }));

      expect(lastConnection?.accessToken).toBe('FROM_AUTHINFO');
      expect(cm.getCurrentOrg()?.accessToken).toBe('FROM_AUTHINFO');
    });

    it('emits connectionChanged carrying the reconciled token', async () => {
      onIdentity = (conn) => {
        conn.accessToken = 'FRESH';
      };
      const cm = new ConnectionManager();
      const events: Array<{ connected: boolean; org?: { accessToken?: string } }> = [];
      cm.on('connectionChanged', (e) => events.push(e));

      await cm.connect(org({ accessToken: 'STALE' }));

      expect(events[0].org?.accessToken).toBe('FRESH');
    });

    it('a superseded refresh does not clear a newer one', async () => {
      const cm = new ConnectionManager();
      await cm.connect(org({ alias: 'a' }));

      autoResolveIdentity = false; // park the refresh probes
      const stale = cm.ensureValidSession();
      cm.disconnect(); // clears _sessionRefresh while `stale` is still in flight

      autoResolveIdentity = true;
      await cm.connect(org({ alias: 'b' }));
      autoResolveIdentity = false;
      const current = cm.ensureValidSession();

      identityDeferreds[0].resolve(); // the stale refresh settles last
      await flush();

      // Its finally() must not have nulled the entry `current` registered
      expect((cm as unknown as { _sessionRefresh: unknown })._sessionRefresh).not.toBeNull();

      identityDeferreds[1].resolve();
      await Promise.all([stale, current]);
    });

    it('ensureValidSession() reports false when the token was already valid', async () => {
      const cm = new ConnectionManager();
      await cm.connect(org());

      expect(await cm.ensureValidSession()).toBe(false);
    });

    it('ensureValidSession() falls back to the SF CLI when jsforce cannot refresh', async () => {
      const cm = new ConnectionManager();
      await cm.connect(org({ alias: 'myorg' }));
      identityError = Object.assign(new Error('expired'), { errorCode: 'INVALID_SESSION_ID' });
      getOrgDetailsMock.mockResolvedValue(org({ alias: 'myorg', accessToken: 'CLI_TOKEN' }));

      expect(await cm.ensureValidSession()).toBe(true);
      expect(refreshOrgTokenMock).toHaveBeenCalledWith('myorg');
      // Patched in place — YAML JS scripts hold this very object
      expect(lastConnection?.accessToken).toBe('CLI_TOKEN');
      expect(cm.getCurrentOrg()?.accessToken).toBe('CLI_TOKEN');
    });

    it('ensureValidSession() reports false when both refresh tiers fail', async () => {
      const cm = new ConnectionManager();
      await cm.connect(org());
      identityError = new Error('expired');
      getOrgDetailsMock.mockRejectedValue(new Error('no credentials'));

      expect(await cm.ensureValidSession()).toBe(false);
    });

    it('collapses concurrent refreshes into a single attempt', async () => {
      const cm = new ConnectionManager();
      await cm.connect(org());
      identityCallCount = 0;
      onIdentity = (conn) => {
        conn.accessToken = 'TOKEN2';
      };

      const [a, b, c] = await Promise.all([
        cm.ensureValidSession(),
        cm.ensureValidSession(),
        cm.ensureValidSession(),
      ]);

      expect([a, b, c]).toEqual([true, true, true]);
      expect(identityCallCount).toBe(1);
    });

    it('retries a jsforce call once after renewing an expired session', async () => {
      const cm = new ConnectionManager();
      await cm.connect(org());
      onIdentity = (conn) => {
        conn.accessToken = 'TOKEN2';
      };
      queryMock
        .mockRejectedValueOnce(
          Object.assign(new Error('expired'), {
            errorCode: 'INVALID_SESSION_ID',
          }),
        )
        .mockResolvedValueOnce({ records: [{ Id: '1' }] });

      const result = await cm.query('SELECT Id FROM Account');

      expect(result).toEqual({ records: [{ Id: '1' }] });
      expect(queryMock).toHaveBeenCalledTimes(2);
    });

    it('does not loop when the retried jsforce call fails again', async () => {
      const cm = new ConnectionManager();
      await cm.connect(org());
      onIdentity = (conn) => {
        conn.accessToken = 'TOKEN2';
      };
      queryMock.mockRejectedValue(
        Object.assign(new Error('expired'), { errorCode: 'INVALID_SESSION_ID' }),
      );

      await expect(cm.query('SELECT Id FROM Account')).rejects.toThrow('expired');
      expect(queryMock).toHaveBeenCalledTimes(2);
    });

    it('propagates non-session errors without attempting a refresh', async () => {
      const cm = new ConnectionManager();
      await cm.connect(org());
      identityCallCount = 0;
      queryMock.mockRejectedValue(
        Object.assign(new Error('bad field'), { errorCode: 'INVALID_FIELD' }),
      );

      await expect(cm.query('SELECT Nope FROM Account')).rejects.toThrow('bad field');
      expect(queryMock).toHaveBeenCalledTimes(1);
      expect(identityCallCount).toBe(0);
    });
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

    /** The canonical Salesforce 401 body for a dead session. */
    const invalidSession = [{ errorCode: 'INVALID_SESSION_ID', message: 'Session expired' }];

    it('renews the session and replays the request on an expired-session 401', async () => {
      const cm = new ConnectionManager();
      await cm.connect(org());
      onIdentity = (conn) => {
        conn.accessToken = 'TOKEN2';
      };
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(fakeResponse({ status: 401, json: invalidSession }))
        .mockResolvedValueOnce(fakeResponse({ status: 200, json: { ok: true } }));
      vi.stubGlobal('fetch', fetchMock);

      const result = await cm.request({ method: 'POST', url: '/x', body: '{}' });

      expect(result.status).toBe(200);
      expect(result.sessionRefreshed).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // The replay carries the renewed token
      expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer TOKEN2');
      vi.unstubAllGlobals();
    });

    it('returns the original 401 when the session could not be renewed', async () => {
      const cm = new ConnectionManager();
      await cm.connect(org());
      identityError = new Error('expired');
      getOrgDetailsMock.mockRejectedValue(new Error('no credentials'));
      const fetchMock = vi
        .fn()
        .mockResolvedValue(fakeResponse({ status: 401, json: invalidSession }));
      vi.stubGlobal('fetch', fetchMock);

      const result = await cm.request({ method: 'GET', url: '/x' });

      expect(result.status).toBe(401);
      expect(result.sessionRefreshed).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      vi.unstubAllGlobals();
    });

    it('does not refresh on a 401 that a new token would not fix', async () => {
      const cm = new ConnectionManager();
      await cm.connect(org());
      identityCallCount = 0;
      const fetchMock = vi.fn().mockResolvedValue(
        fakeResponse({
          status: 401,
          json: [{ message: 'This session is not valid for use with the REST API' }],
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const result = await cm.request({ method: 'GET', url: '/x' });

      expect(result.status).toBe(401);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(identityCallCount).toBe(0);
      vi.unstubAllGlobals();
    });

    it('does not refresh org credentials for a 401 from a third-party host', async () => {
      const cm = new ConnectionManager();
      await cm.connect(org());
      identityCallCount = 0;
      const fetchMock = vi
        .fn()
        .mockResolvedValue(fakeResponse({ status: 401, json: invalidSession }));
      vi.stubGlobal('fetch', fetchMock);

      const result = await cm.request({ method: 'GET', url: 'https://other-host.example.com/x' });

      expect(result.status).toBe(401);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(identityCallCount).toBe(0);
      vi.unstubAllGlobals();
    });
  });

  describe('getReleaseInfo()', () => {
    function versionsResponse(versions: unknown) {
      return {
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'application/json' }),
        json: vi.fn().mockResolvedValue(versions),
        text: vi.fn().mockResolvedValue(''),
      };
    }

    const versions = [
      { label: 'Winter ’25', version: '62.0' },
      { label: 'Summer ’26', version: '67.0' },
      { label: 'Spring ’26', version: '66.0' },
    ];

    it('throws when not connected', async () => {
      const cm = new ConnectionManager();
      await expect(cm.getReleaseInfo()).rejects.toThrow();
    });

    it('returns the highest version and caches it per org', async () => {
      const cm = new ConnectionManager();
      await cm.connect(org());
      const fetchMock = vi.fn().mockResolvedValue(versionsResponse(versions));
      vi.stubGlobal('fetch', fetchMock);

      expect(await cm.getReleaseInfo()).toEqual({ apiVersion: '67.0', label: 'Summer ’26' });
      expect(await cm.getReleaseInfo()).toEqual({ apiVersion: '67.0', label: 'Summer ’26' });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0][0]).toBe('https://example.my.salesforce.com/services/data');
      vi.unstubAllGlobals();
    });

    it('compares versions numerically, not lexicographically', async () => {
      const cm = new ConnectionManager();
      await cm.connect(org());
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          versionsResponse([
            { label: 'A', version: '9.0' },
            { label: 'B', version: '67.0' },
          ]),
        ),
      );

      expect((await cm.getReleaseInfo()).apiVersion).toBe('67.0');
      vi.unstubAllGlobals();
    });

    it('re-fetches after disconnect clears the cache', async () => {
      const cm = new ConnectionManager();
      await cm.connect(org());
      const fetchMock = vi.fn().mockResolvedValue(versionsResponse(versions));
      vi.stubGlobal('fetch', fetchMock);

      await cm.getReleaseInfo();
      cm.disconnect();
      await cm.connect(org());
      await cm.getReleaseInfo();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      vi.unstubAllGlobals();
    });

    it('throws on an unexpected response shape', async () => {
      const cm = new ConnectionManager();
      await cm.connect(org());
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(versionsResponse({ error: 'nope' })));

      await expect(cm.getReleaseInfo()).rejects.toThrow(/services\/data/);
      vi.unstubAllGlobals();
    });
  });
});

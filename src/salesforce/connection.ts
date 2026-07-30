import * as jsforce from '@jsforce/jsforce-node';
import { EventEmitter } from 'events';
import {
  getConnectionOptions,
  getOrgDetails,
  refreshOrgToken,
  type OrgConnectionOptions,
  type OrgDetails,
} from '../utils/sfCli';
import { buildExecuteAnonymousEnvelope } from './soap/SoapEnvelope';
import { postSoapRequest } from './soap/SoapClient';
import {
  extractSoapFault,
  isSoapSessionExpired,
  parseExecuteAnonymousResponse,
  type ExecuteAnonymousSoapResult,
} from './soap/SoapResponseParser';

export interface ConnectionChangedEvent {
  connected: boolean;
  org?: OrgDetails;
}

/** HTTP methods the REST tab exposes — a subset of jsforce's HttpMethods. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Result of a raw REST call — status/headers exposed since jsforce's own request() never surfaces them. */
export interface RawHttpResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
  /** True when the first attempt hit an expired session and this is the post-refresh replay. */
  sessionRefreshed?: boolean;
}

export type { ApexLogLevel } from './soap/SoapEnvelope';
import type { ApexLogLevel } from './soap/SoapEnvelope';

export interface DebuggingOptions {
  logLevels?: {
    Db?: ApexLogLevel;
    Workflow?: ApexLogLevel;
    Validation?: ApexLogLevel;
    Callout?: ApexLogLevel;
    Apex_code?: ApexLogLevel;
    Apex_profiling?: ApexLogLevel;
    Visualforce?: ApexLogLevel;
    System?: ApexLogLevel;
  };
}

export interface OrganizationDetails extends Record<string, unknown> {
  Id: string;
  Name: string;
  IsSandbox: boolean;
  InstanceName: string;
  OrganizationType: string;
  NamespacePrefix: string | null;
}

/** Latest API version supported by the connected org, and its release label (e.g. "Summer '26"). */
export interface ReleaseInfo {
  apiVersion: string;
  label: string;
}

const NOT_CONNECTED = 'Not connected to any Salesforce org.';

/**
 * 401s that a fresh access token would NOT fix — connected-app, OAuth policy or IP
 * restrictions. Mirrors jsforce's own skip-list (see its http-api `isSessionExpired`);
 * without it we would refresh pointlessly on every such call.
 */
const NON_SESSION_401_MARKERS = [
  'Connected app is not attached to Agent',
  'This session is not valid for use with the REST API',
];

/** Config accepted by `new jsforce.Connection()` — the package doesn't re-export the type. */
type JsforceConnectionConfig = NonNullable<ConstructorParameters<typeof jsforce.Connection>[0]>;

/**
 * Collaborators of {@link ConnectionManager}. The auth lookups are injectable so tests can
 * exercise the token-refresh paths without a real org; each defaults to its `sfCli`
 * implementation. `log` writes to the Force Cockpit output channel.
 */
export interface ConnectionManagerDeps {
  getConnectionOptions?: (username: string) => Promise<OrgConnectionOptions>;
  getOrgDetails?: (aliasOrUsername: string) => Promise<OrgDetails>;
  refreshOrgToken?: (aliasOrUsername: string) => Promise<void>;
  log?: (message: string) => void;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True for the jsforce/Salesforce error shapes that signal an expired or invalid session. */
function isInvalidSessionError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const { errorCode, name, message } = err as {
    errorCode?: unknown;
    name?: unknown;
    message?: unknown;
  };
  return [errorCode, name, message].some(
    (value) => typeof value === 'string' && value.includes('INVALID_SESSION_ID'),
  );
}

export class ConnectionManager extends EventEmitter {
  private _connection: jsforce.Connection | null = null;
  private _currentOrg: OrgDetails | null = null;
  private _connectingTarget: string | null = null;
  private _connectVersion = 0;
  private _apiVersion = '65.0';
  private _orgDetailsCache = new Map<string, OrganizationDetails>();
  private _releaseInfoCache = new Map<string, ReleaseInfo>();
  /** In-flight {@link ensureValidSession} call — collapses concurrent refreshes into one. */
  private _sessionRefresh: Promise<boolean> | null = null;

  constructor(private readonly deps: ConnectionManagerDeps = {}) {
    super();
  }

  private log(message: string): void {
    this.deps.log?.(message);
  }

  setApiVersion(version: string): void {
    this._apiVersion = version;
  }

  /** The API version used for jsforce connections and REST/Tooling endpoint paths. */
  get apiVersion(): string {
    return this._apiVersion;
  }

  get isConnected(): boolean {
    return this._connection !== null;
  }

  get isConnecting(): boolean {
    return this._connectingTarget !== null;
  }

  get connectingTarget(): string | null {
    return this._connectingTarget;
  }

  getConnection(): jsforce.Connection | null {
    return this._connection;
  }

  getCurrentOrg(): OrgDetails | null {
    return this._currentOrg;
  }

  async connect(org: OrgDetails): Promise<void> {
    const target = org.alias || org.username;

    if (this._connectingTarget === target) {
      return;
    }

    this._connectingTarget = target;
    const version = ++this._connectVersion;
    try {
      const conn = new jsforce.Connection(await this.buildConnectionConfig(org));
      // jsforce's SessionRefreshDelegate assigns the renewed token to `conn` itself; this
      // keeps the OrgDetails snapshot in step (buildOrgUrl reads accessToken off it).
      conn.on('refresh', (token: string) => this.onTokenRefreshed(conn, token));

      // Verify connection works
      await conn.identity();

      // Discard if a disconnect() or newer connect() ran while we were awaiting
      if (this._connectVersion !== version) return;

      this._connection = conn;
      this._currentOrg = this.syncOrgToken(org, conn);
      this.emit('connectionChanged', {
        connected: true,
        org: this._currentOrg,
      } as ConnectionChangedEvent);
    } finally {
      // Only clear our own target — a newer connect() may have already set a different one
      if (this._connectingTarget === target) this._connectingTarget = null;
    }
  }

  /**
   * Builds the jsforce config, preferring the auth options from `AuthInfo` because they
   * carry the `refreshFn` that lets jsforce renew an expired access token by itself (and
   * persist it back to the auth file). Falls back to the plain token snapshot in
   * {@link OrgDetails} when those aren't available — e.g. access-token-only auth.
   */
  private async buildConnectionConfig(org: OrgDetails): Promise<JsforceConnectionConfig> {
    const options = await this.loadConnectionOptions(org.username);
    const config: JsforceConnectionConfig = {
      instanceUrl: options?.instanceUrl ?? org.instanceUrl,
      accessToken: options?.accessToken ?? org.accessToken,
      version: this._apiVersion,
    };
    if (options?.oauth2) config.oauth2 = options.oauth2;
    if (options?.refreshFn) {
      // Cast: the fn comes from @salesforce/core's own bundled jsforce, a different type
      // identity from ours, but the SessionRefreshFunc contract is identical.
      config.refreshFn = options.refreshFn as unknown as JsforceConnectionConfig['refreshFn'];
    }
    return config;
  }

  private async loadConnectionOptions(username: string): Promise<OrgConnectionOptions | null> {
    try {
      const options = await (this.deps.getConnectionOptions ?? getConnectionOptions)(username);
      if (!options.refreshFn) {
        this.log(
          `[Connection] No refresh function available for ${username}; the session cannot be renewed in-process.`,
        );
      }
      return options;
    } catch (err) {
      this.log(
        `[Connection] Could not read refreshable auth for ${username}; using the stored access token. ${errorText(err)}`,
      );
      return null;
    }
  }

  /**
   * Reconciles the OrgDetails snapshot with the token the connection actually ended up
   * holding. Two ways they diverge, both of which leave `buildOrgUrl`'s
   * `frontdoor.jsp?sid=` pointing at a dead session:
   *  - jsforce refreshed the token during connect()'s `identity()` probe. That fires
   *    'refresh' before `_connection` is assigned, so {@link onTokenRefreshed} rightly
   *    ignores it as a not-yet-current connection and the new token is dropped.
   *  - {@link buildConnectionConfig} preferred AuthInfo's token over the OrgDetails one.
   *
   * Neither is self-healing: a later {@link ensureValidSession} sees a valid token,
   * reports "nothing changed" and never rewrites the snapshot.
   */
  private syncOrgToken(org: OrgDetails, conn: jsforce.Connection): OrgDetails {
    const token = conn.accessToken;
    return token && token !== org.accessToken ? { ...org, accessToken: token } : org;
  }

  private onTokenRefreshed(conn: jsforce.Connection, token: string): void {
    if (conn !== this._connection || !this._currentOrg) return;
    this._currentOrg = { ...this._currentOrg, accessToken: token };
    this.log('[Connection] Access token renewed by jsforce.');
  }

  /**
   * Ensures the connection holds a usable access token, renewing it when it has expired.
   * Single-flight — concurrent callers share one refresh. Returns true only when the token
   * actually changed, so callers know whether replaying their request is worth it.
   *
   * Tier 1 makes a cheap authenticated call so jsforce's own refresh delegate can do the
   * work; tier 2 falls back to `sf org display`, which makes the CLI rewrite the auth file.
   */
  async ensureValidSession(): Promise<boolean> {
    if (!this._connection) return false;
    if (!this._sessionRefresh) {
      const pending: Promise<boolean> = this.refreshSession().finally(() => {
        // Clear only our own entry: disconnect() may have dropped it already and a newer
        // call registered its refresh in the meantime — nulling that would let the next
        // caller start a second, redundant refresh.
        if (this._sessionRefresh === pending) this._sessionRefresh = null;
      });
      this._sessionRefresh = pending;
    }
    return this._sessionRefresh;
  }

  private async refreshSession(): Promise<boolean> {
    const conn = this._connection;
    const org = this._currentOrg;
    if (!conn || !org) return false;
    const previousToken = conn.accessToken;

    // Tier 1 — identity() is the cheapest authenticated endpoint. With a refreshFn
    // installed, jsforce intercepts the 401, mints a new token, assigns it and replays.
    // A still-valid token simply succeeds here and reports "nothing changed".
    try {
      await conn.identity();
      if (this._connection !== conn) return false; // disconnected or reconnected meanwhile
      return conn.accessToken !== previousToken;
    } catch (err) {
      if (this._connection !== conn) return false;
      this.log(
        `[Connection] In-process token refresh unavailable, falling back to the SF CLI. ${errorText(err)}`,
      );
    }

    // Tier 2 — patch the live connection in place rather than reconnecting: YAML JS
    // scripts are handed the raw jsforce Connection and must see the new token too.
    const target = org.alias || org.username;
    try {
      await (this.deps.refreshOrgToken ?? refreshOrgToken)(target);
      const details = await (this.deps.getOrgDetails ?? getOrgDetails)(target);
      if (this._connection !== conn) return false;
      conn.accessToken = details.accessToken;
      conn.instanceUrl = details.instanceUrl;
      this._currentOrg = details;
      if (details.accessToken === previousToken) {
        this.log('[Connection] SF CLI refresh returned the same access token.');
        return false;
      }
      this.log('[Connection] Access token renewed via the SF CLI.');
      return true;
    } catch (err) {
      this.log(`[Connection] Token refresh failed for "${target}". ${errorText(err)}`);
      return false;
    }
  }

  /**
   * Runs a jsforce call, renewing the session and retrying once on INVALID_SESSION_ID.
   * A safety net: when a refreshFn is installed jsforce recovers before the error ever
   * surfaces, so this only fires for connections built without one.
   */
  private async withSessionRetry<T>(run: () => PromiseLike<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (!isInvalidSessionError(err)) throw err;
      if (!(await this.ensureValidSession())) throw err;
      return run();
    }
  }

  disconnect(): void {
    this._connectVersion++; // invalidate any in-flight connect()
    this._connectingTarget = null;
    this._connection = null;
    this._currentOrg = null;
    this._sessionRefresh = null;
    this._orgDetailsCache.clear();
    this._releaseInfoCache.clear();
    this.emit('connectionChanged', { connected: false } as ConnectionChangedEvent);
  }

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    soql: string,
  ): Promise<jsforce.QueryResult<T>> {
    if (!this._connection) {
      throw new Error(NOT_CONNECTED);
    }
    const conn = this._connection;
    return this.withSessionRetry(() => conn.query<T>(soql));
  }

  async describeGlobal(): Promise<jsforce.DescribeGlobalResult> {
    if (!this._connection) {
      throw new Error(NOT_CONNECTED);
    }
    const conn = this._connection;
    return this.withSessionRetry(() => conn.describeGlobal());
  }

  async describeSObject(name: string): Promise<jsforce.DescribeSObjectResult> {
    if (!this._connection) {
      throw new Error(NOT_CONNECTED);
    }
    const conn = this._connection;
    return this.withSessionRetry(() => conn.describe(name));
  }

  async executeAnonymous(apexBody: string): Promise<{
    compiled: boolean;
    success: boolean;
    compileProblem: string | null;
    exceptionMessage: string | null;
    exceptionStackTrace: string | null;
  }> {
    if (!this._connection) {
      throw new Error(NOT_CONNECTED);
    }
    const conn = this._connection;
    const result = await this.withSessionRetry(() => conn.tooling.executeAnonymous(apexBody));
    return result as {
      compiled: boolean;
      success: boolean;
      compileProblem: string | null;
      exceptionMessage: string | null;
      exceptionStackTrace: string | null;
    };
  }

  /**
   * Executes anonymous Apex via SOAP API with DebuggingHeader.
   * Returns both execution result and debug log in one call.
   * Does NOT require debug logging to be enabled in Salesforce Setup.
   *
   * @param apexBody - The Apex code to execute
   * @param options - Optional debugging options (log levels)
   * @returns Execution result with debug log
   */
  async executeAnonymousWithDebugLog(
    apexBody: string,
    options?: DebuggingOptions,
  ): Promise<ExecuteAnonymousSoapResult> {
    if (!this._connection) {
      throw new Error(NOT_CONNECTED);
    }

    // Defaults: all NONE except Apex_code: DEBUG
    const logLevels = {
      Db: 'NONE' as ApexLogLevel,
      Workflow: 'NONE' as ApexLogLevel,
      Validation: 'NONE' as ApexLogLevel,
      Callout: 'NONE' as ApexLogLevel,
      Apex_code: 'DEBUG' as ApexLogLevel,
      Apex_profiling: 'NONE' as ApexLogLevel,
      Visualforce: 'NONE' as ApexLogLevel,
      System: 'NONE' as ApexLogLevel,
      ...options?.logLevels,
    };

    // Read the token at send time, not once up front: a refresh mutates `conn` in place,
    // so the replay below must rebuild the envelope to pick up the new session id.
    const conn = this._connection;
    const post = (): Promise<string> =>
      postSoapRequest(
        conn.instanceUrl,
        conn.version,
        buildExecuteAnonymousEnvelope(apexBody, conn.accessToken ?? '', logLevels),
      );

    // This path bypasses jsforce's HTTP stack, so its refresh delegate never sees the
    // fault — detect the expired session ourselves and replay once.
    let xml = await post();
    if (isSoapSessionExpired(xml) && (await this.ensureValidSession())) {
      xml = await post();
    }
    const fault = extractSoapFault(xml);
    if (fault) {
      throw new Error(`Salesforce SOAP fault: ${fault}`);
    }
    return parseExecuteAnonymousResponse(xml);
  }

  async toolingQuery<T extends Record<string, unknown> = Record<string, unknown>>(
    soql: string,
  ): Promise<jsforce.QueryResult<T>> {
    if (!this._connection) {
      throw new Error(NOT_CONNECTED);
    }
    const conn = this._connection;
    return this.withSessionRetry(() => conn.tooling.query<T>(soql));
  }

  async toolingRequest(urlPath: string): Promise<string> {
    if (!this._connection) {
      throw new Error(NOT_CONNECTED);
    }
    const conn = this._connection;
    return this.withSessionRetry(() => conn.request(urlPath) as Promise<string>);
  }

  /**
   * Generic REST request against the connected org. Bypasses jsforce (whose `request()`
   * only ever resolves with the parsed body — no way to read HTTP status or response
   * headers on success) in favor of a direct `fetch` call against `instanceUrl`, with
   * the Bearer token attached manually. Used by the REST tab to call arbitrary REST /
   * Apex REST endpoints. Does NOT throw on a non-2xx status — the caller decides how to
   * present it; only network-level failures (DNS, TLS, connection refused) throw.
   */
  async request(options: {
    method: HttpMethod;
    url: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<RawHttpResult> {
    if (!this._connection) {
      throw new Error(NOT_CONNECTED);
    }
    const result = await this.rawFetch(options);
    if (!this.isSessionExpiredResponse(result, options.url)) return result;
    if (!(await this.ensureValidSession())) return result;
    // Safe to replay any verb: an INVALID_SESSION_ID is rejected at the auth layer, so
    // the original request never reached the org's business logic.
    return { ...(await this.rawFetch(options)), sessionRefreshed: true };
  }

  private async rawFetch(options: {
    method: HttpMethod;
    url: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<RawHttpResult> {
    const conn = this._connection!;
    const url = /^https?:\/\//i.test(options.url)
      ? options.url
      : `${conn.instanceUrl}${options.url}`;
    const response = await fetch(url, {
      method: options.method,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${conn.accessToken ?? ''}`,
      },
      body: options.body,
    });
    const headers = Object.fromEntries(response.headers.entries());
    const contentType = response.headers.get('content-type') ?? '';
    const body = contentType.includes('json')
      ? await response.json().catch(() => null)
      : await response.text();
    return { status: response.status, statusText: response.statusText, headers, body };
  }

  /**
   * Whether a 401 means "the session expired" rather than "this request is not allowed".
   * Excludes the connected-app/policy rejections a new token wouldn't fix, and requests
   * aimed off-org — the REST tab accepts arbitrary absolute URLs, and a third-party host
   * returning 401 is no reason to renew Salesforce credentials.
   */
  private isSessionExpiredResponse(result: RawHttpResult, requestedUrl: string): boolean {
    if (result.status !== 401) return false;
    if (!this.targetsConnectedOrg(requestedUrl)) return false;
    const body = typeof result.body === 'string' ? result.body : JSON.stringify(result.body ?? '');
    return !NON_SESSION_401_MARKERS.some((marker) => body.includes(marker));
  }

  private targetsConnectedOrg(requestedUrl: string): boolean {
    // Relative paths are resolved against instanceUrl, so they always hit the org.
    if (!/^https?:\/\//i.test(requestedUrl)) return true;
    try {
      return new URL(requestedUrl).origin === new URL(this._connection!.instanceUrl).origin;
    } catch {
      return false;
    }
  }

  isSandbox(): boolean {
    if (!this._currentOrg) return false;
    const url = this._currentOrg.instanceUrl || '';
    // Sandboxes typically have --sandbox or .sandbox. or cs* patterns
    // But the most reliable way is checking the username for a sandbox suffix
    // If instanceUrl contains 'sandbox' or '--', it's a sandbox
    return url.includes('--') || url.includes('.sandbox.') || url.includes('.cs');
  }

  async getLimits(): Promise<{
    DataStorageMB: { Max: number; Remaining: number };
    FileStorageMB: { Max: number; Remaining: number };
  }> {
    if (!this._connection) {
      throw new Error(NOT_CONNECTED);
    }
    const conn = this._connection;
    const result = await this.withSessionRetry(() =>
      conn.request(`/services/data/v${this._apiVersion}/limits`),
    );
    const limits = result as Record<string, { Max: number; Remaining: number }>;
    return {
      DataStorageMB: limits.DataStorageMB,
      FileStorageMB: limits.FileStorageMB,
    };
  }

  async getOrganizationDetails(): Promise<OrganizationDetails> {
    if (!this._currentOrg) throw new Error(NOT_CONNECTED);
    const orgId = this._currentOrg.orgId;
    if (this._orgDetailsCache.has(orgId)) {
      return this._orgDetailsCache.get(orgId)!;
    }
    const result = await this.query<OrganizationDetails>(
      'SELECT Id, Name, IsSandbox, InstanceName, OrganizationType, NamespacePrefix FROM Organization',
    );
    const details = result.records[0];
    this._orgDetailsCache.set(orgId, details);
    return details;
  }

  /**
   * Latest API version the org supports, from the version-less `/services/data` endpoint
   * (which lists every supported version). Distinct from `apiVersion`, which is the
   * user-configured version this extension talks to the org with.
   */
  async getReleaseInfo(): Promise<ReleaseInfo> {
    if (!this._currentOrg) throw new Error(NOT_CONNECTED);
    const orgId = this._currentOrg.orgId;
    const cached = this._releaseInfoCache.get(orgId);
    if (cached) return cached;

    const result = await this.request({ method: 'GET', url: '/services/data' });
    const versions = result.body as { version?: string; label?: string }[];
    if (!Array.isArray(versions) || versions.length === 0) {
      throw new Error(`Unexpected /services/data response (status ${result.status}).`);
    }
    const latest = versions.reduce((a, b) =>
      parseFloat(b.version ?? '0') > parseFloat(a.version ?? '0') ? b : a,
    );
    const info: ReleaseInfo = { apiVersion: latest.version ?? '', label: latest.label ?? '' };
    this._releaseInfoCache.set(orgId, info);
    return info;
  }

  async isProductionOrg(): Promise<boolean> {
    return !(await this.getOrganizationDetails()).IsSandbox;
  }

  getSandboxName(): string | null {
    if (!this._currentOrg) return null;
    const instanceUrl = this._currentOrg.instanceUrl || '';
    // Strip protocol and known Salesforce domain suffixes to isolate the org identifier.
    // e.g. https://pablo--uatest.sandbox.my.salesforce.com → pablo--uatest
    const orgName = instanceUrl
      .replace(/^https?:\/\//i, '')
      .replace(/(\.sandbox)?(\.my)?\.salesforce\.com$/i, '');
    // Sandbox org names follow the pattern: orgname--sandboxname
    const parts = orgName.split('--');
    return parts.length > 1 ? parts[parts.length - 1] : null;
  }
}

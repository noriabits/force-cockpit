import * as jsforce from 'jsforce';
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { EventEmitter } from 'events';
import type { OrgDetails } from '../utils/sfCli';

export interface ConnectionChangedEvent {
  connected: boolean;
  org?: OrgDetails;
}

export type ApexLogLevel =
  | 'NONE'
  | 'ERROR'
  | 'WARN'
  | 'INFO'
  | 'DEBUG'
  | 'FINE'
  | 'FINER'
  | 'FINEST';

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

const NOT_CONNECTED = 'Not connected to any Salesforce org.';

export class ConnectionManager extends EventEmitter {
  private _connection: jsforce.Connection | null = null;
  private _currentOrg: OrgDetails | null = null;
  private _connectingTarget: string | null = null;
  private _connectVersion = 0;
  private _apiVersion = '65.0';
  private _orgDetailsCache = new Map<string, OrganizationDetails>();

  setApiVersion(version: string): void {
    this._apiVersion = version;
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
      const conn = new jsforce.Connection({
        instanceUrl: org.instanceUrl,
        accessToken: org.accessToken,
        version: this._apiVersion,
      });

      // Verify connection works
      await conn.identity();

      // Discard if a disconnect() or newer connect() ran while we were awaiting
      if (this._connectVersion !== version) return;

      this._connection = conn;
      this._currentOrg = org;
      this.emit('connectionChanged', { connected: true, org } as ConnectionChangedEvent);
    } finally {
      // Only clear our own target — a newer connect() may have already set a different one
      if (this._connectingTarget === target) this._connectingTarget = null;
    }
  }

  disconnect(): void {
    this._connectVersion++; // invalidate any in-flight connect()
    this._connectingTarget = null;
    this._connection = null;
    this._currentOrg = null;
    this._orgDetailsCache.clear();
    this.emit('connectionChanged', { connected: false } as ConnectionChangedEvent);
  }

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    soql: string,
  ): Promise<jsforce.QueryResult<T>> {
    if (!this._connection) {
      throw new Error(NOT_CONNECTED);
    }
    return this._connection.query<T>(soql);
  }

  async describeGlobal(): Promise<jsforce.DescribeGlobalResult> {
    if (!this._connection) {
      throw new Error(NOT_CONNECTED);
    }
    return this._connection.describeGlobal();
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
    const result = await conn.tooling.executeAnonymous(apexBody);
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
  ): Promise<{
    compiled: boolean;
    success: boolean;
    compileProblem: string | null;
    exceptionMessage: string | null;
    exceptionStackTrace: string | null;
    debugLog: string;
  }> {
    if (!this._connection) {
      throw new Error(NOT_CONNECTED);
    }

    // Set default log levels (all NONE except Apex_code: DEBUG)
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

    // Build SOAP envelope with DebuggingHeader
    const soapEnvelope = this.buildSoapEnvelope(apexBody, logLevels);

    // Send SOAP request — use raw HTTP to get the XML string back (jsforce.request parses XML into objects)
    const response = await this.makeSoapRequest(soapEnvelope);

    // Parse SOAP response
    return this.parseSoapResponse(response);
  }

  private buildSoapEnvelope(apexBody: string, logLevels: Record<string, ApexLogLevel>): string {
    // Escape Apex code for XML (CDATA handles most cases, but still escape for safety)
    const escapedApex = apexBody.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Build categories XML
    const categories = Object.entries(logLevels)
      .filter(([_, level]) => level !== 'NONE')
      .map(
        ([category, level]) => `
        <apex:categories>
          <apex:category>${category}</apex:category>
          <apex:level>${level}</apex:level>
        </apex:categories>`,
      )
      .join('');

    return `<?xml version="1.0" encoding="utf-8"?>
      <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:apex="http://soap.sforce.com/2006/08/apex">
        <soapenv:Header>
          <apex:DebuggingHeader>${categories}
          </apex:DebuggingHeader>
          <apex:SessionHeader>
            <apex:sessionId>${this._connection!.accessToken}</apex:sessionId>
          </apex:SessionHeader>
        </soapenv:Header>
        <soapenv:Body>
          <apex:executeAnonymous>
            <apex:String>${escapedApex}</apex:String>
          </apex:executeAnonymous>
        </soapenv:Body>
      </soapenv:Envelope>`;
  }

  private makeSoapRequest(soapEnvelope: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const instanceUrl = this._connection!.instanceUrl;
      const url = new URL(`/services/Soap/s/${this._connection!.version}`, instanceUrl);
      const body = Buffer.from(soapEnvelope, 'utf-8');
      const options = {
        hostname: url.hostname,
        port: url.port ? parseInt(url.port, 10) : url.protocol === 'https:' ? 443 : 80,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          SOAPAction: '""',
          'Content-Length': body.length,
          'Accept-Encoding': 'identity', // prevent gzip — we read raw bytes as UTF-8 string
        },
      };
      const transport = url.protocol === 'https:' ? https : http;
      const req = transport.request(options, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on('end', () => {
          resolve(data);
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  private parseSoapResponse(xmlResponse: string): {
    compiled: boolean;
    success: boolean;
    compileProblem: string | null;
    exceptionMessage: string | null;
    exceptionStackTrace: string | null;
    debugLog: string;
  } {
    // Extract execution result from SOAP Body
    const compiled = this.extractXmlValue(xmlResponse, 'compiled') === 'true';
    const success = this.extractXmlValue(xmlResponse, 'success') === 'true';
    const compileProblem = this.extractXmlValue(xmlResponse, 'compileProblem') || null;
    const exceptionMessage = this.extractXmlValue(xmlResponse, 'exceptionMessage') || null;
    const exceptionStackTrace = this.extractXmlValue(xmlResponse, 'exceptionStackTrace') || null;

    // Extract debug log from SOAP Header (plain text inside XML — never base64-encoded)
    const debugLog = this.extractXmlValue(xmlResponse, 'debugLog') || '';

    return {
      compiled,
      success,
      compileProblem,
      exceptionMessage,
      exceptionStackTrace,
      debugLog,
    };
  }

  private extractXmlValue(xml: string, tagName: string): string {
    // Simple regex-based XML extraction (avoids heavy XML parser dependency)
    const regex = new RegExp(`<[^:]*:?${tagName}[^>]*>([\\s\\S]*?)<\\/[^:]*:?${tagName}>`, 'i');
    const match = xml.match(regex);
    if (!match) return '';
    return match[1]
      .trim()
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }

  async toolingQuery<T extends Record<string, unknown> = Record<string, unknown>>(
    soql: string,
  ): Promise<jsforce.QueryResult<T>> {
    if (!this._connection) {
      throw new Error(NOT_CONNECTED);
    }
    return this._connection.tooling.query<T>(soql);
  }

  async toolingRequest(urlPath: string): Promise<string> {
    if (!this._connection) {
      throw new Error(NOT_CONNECTED);
    }
    return this._connection.request(urlPath) as Promise<string>;
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
    const result = await this._connection.request(`/services/data/v${this._apiVersion}/limits`);
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

import type { ConnectionManager } from '../../salesforce/connection';
import type { DescribeDiskCache } from './DescribeDiskCache';

/** Lightweight projection of a global sObject entry sent to the webview. */
export interface DescribeGlobalSObject {
  name: string;
  label: string;
  keyPrefix: string | null;
}

/** Lightweight projection of a field sent to the webview for autocomplete. */
export interface DescribeField {
  name: string;
  label: string;
  type: string;
  relationshipName: string | null;
  referenceTo: string[];
  picklistValues: string[];
}

export interface DescribeGlobalProjection {
  sobjects: DescribeGlobalSObject[];
}

export interface DescribeSObjectProjection {
  name: string;
  fields: DescribeField[];
}

/**
 * Caching wrapper over ConnectionManager's describe calls. Keeps lookups cheap with a
 * three-tier strategy: an in-memory map (per orgId), an optional persistent
 * {@link DescribeDiskCache} (survives reloads, shared across the window between the SOQL
 * tab's autocomplete and AI scripts), and finally the server. Projected down to only
 * the fields consumers need.
 */
export class DescribeService {
  private globalCache = new Map<string, DescribeGlobalProjection>();
  private sobjectCache = new Map<string, DescribeSObjectProjection>();

  constructor(
    private readonly connectionManager: ConnectionManager,
    private readonly diskCache?: DescribeDiskCache,
  ) {}

  private orgKey(): string {
    return this.connectionManager.getCurrentOrg()?.orgId ?? 'none';
  }

  async describeGlobal(): Promise<DescribeGlobalProjection> {
    const org = this.orgKey();
    const memo = this.globalCache.get(org);
    if (memo) return memo;

    const onDisk = this.diskCache?.readGlobal(org);
    if (onDisk) {
      this.globalCache.set(org, onDisk);
      return onDisk;
    }

    return this.fetchGlobal(org);
  }

  /**
   * Bypasses both cache tiers and re-fetches from the server (still repopulating
   * the cache on return, so later calls benefit). Use this instead of
   * {@link describeGlobal} when the answer must reflect object permissions as of
   * right now — e.g. diagnosing a query failure right after an admin change —
   * since the cache can otherwise serve an org-permission snapshot that is
   * correct for autocomplete's purposes but already stale for that one.
   */
  async describeGlobalFresh(): Promise<DescribeGlobalProjection> {
    return this.fetchGlobal(this.orgKey());
  }

  private async fetchGlobal(org: string): Promise<DescribeGlobalProjection> {
    const result = await this.connectionManager.describeGlobal();
    const projection: DescribeGlobalProjection = {
      sobjects: result.sobjects.map((s) => ({
        name: s.name,
        label: s.label,
        keyPrefix: s.keyPrefix ?? null,
      })),
    };
    this.globalCache.set(org, projection);
    this.diskCache?.writeGlobal(org, projection);
    return projection;
  }

  async describeSObject(name: string): Promise<DescribeSObjectProjection> {
    const org = this.orgKey();
    const key = `${org}:${name.toLowerCase()}`;
    const memo = this.sobjectCache.get(key);
    if (memo) return memo;

    const onDisk = this.diskCache?.readSObject(org, name);
    if (onDisk) {
      this.sobjectCache.set(key, onDisk);
      return onDisk;
    }

    return this.fetchSObject(org, key, name);
  }

  /**
   * Bypasses both cache tiers and re-fetches from the server (still repopulating
   * the cache on return). `describeSObject` is FLS-filtered by Salesforce as of
   * whenever it was last fetched — after a permission change (an admin grants or
   * revokes field access), a cached answer keeps reporting the *old* visibility.
   * Field-level security diagnosis (SoqlDiagnosticsService) needs the field's
   * visibility as of right now, so it always calls this instead.
   */
  async describeSObjectFresh(name: string): Promise<DescribeSObjectProjection> {
    const org = this.orgKey();
    return this.fetchSObject(org, `${org}:${name.toLowerCase()}`, name);
  }

  private async fetchSObject(
    org: string,
    key: string,
    name: string,
  ): Promise<DescribeSObjectProjection> {
    const result = await this.connectionManager.describeSObject(name);
    const projection: DescribeSObjectProjection = {
      name: result.name,
      fields: result.fields.map((f) => ({
        name: f.name,
        label: f.label,
        type: f.type,
        relationshipName: f.relationshipName ?? null,
        referenceTo: (f.referenceTo ?? []).filter((r): r is string => !!r),
        picklistValues: (f.picklistValues ?? [])
          .filter((p) => p.active !== false)
          .map((p) => p.value),
      })),
    };
    this.sobjectCache.set(key, projection);
    this.diskCache?.writeSObject(org, name, projection);
    return projection;
  }

  /** Clear both the in-memory maps and the persistent disk cache. */
  clearCache(): void {
    this.globalCache.clear();
    this.sobjectCache.clear();
    this.diskCache?.clear();
  }
}

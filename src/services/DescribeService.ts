import type { ConnectionManager } from '../salesforce/connection';

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
 * Caching wrapper over ConnectionManager's describe calls. Keeps autocomplete
 * lookups cheap: results are cached per orgId (an org switch naturally misses)
 * and projected down to only the fields the webview needs.
 */
export class DescribeService {
  private globalCache = new Map<string, DescribeGlobalProjection>();
  private sobjectCache = new Map<string, DescribeSObjectProjection>();

  constructor(private readonly connectionManager: ConnectionManager) {}

  private orgKey(): string {
    return this.connectionManager.getCurrentOrg()?.orgId ?? 'none';
  }

  async describeGlobal(): Promise<DescribeGlobalProjection> {
    const key = this.orgKey();
    const cached = this.globalCache.get(key);
    if (cached) return cached;

    const result = await this.connectionManager.describeGlobal();
    const projection: DescribeGlobalProjection = {
      sobjects: result.sobjects.map((s) => ({
        name: s.name,
        label: s.label,
        keyPrefix: s.keyPrefix ?? null,
      })),
    };
    this.globalCache.set(key, projection);
    return projection;
  }

  async describeSObject(name: string): Promise<DescribeSObjectProjection> {
    const key = `${this.orgKey()}:${name.toLowerCase()}`;
    const cached = this.sobjectCache.get(key);
    if (cached) return cached;

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
    return projection;
  }
}

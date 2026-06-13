import * as fs from 'fs';
import * as path from 'path';
import type { DescribeGlobalProjection, DescribeSObjectProjection } from './DescribeService';

/** 2 weeks — Salesforce schema rarely changes and the user can force-refresh via 🔄. */
export const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

interface CacheEntry<T> {
  cachedAt: number;
  data: T;
}

/**
 * Persistent, per-workspace describe cache backed by JSON files. Keyed by orgId so
 * different orgs never collide. Stored under a single gitignored folder (a self-ignoring
 * `.gitignore` of `*` keeps the whole tree untracked, mirroring the `logs/` pattern).
 *
 * All reads tolerate missing/stale/corrupt files (→ `null`) and all writes are
 * best-effort — caching must never break a script run. vscode-free.
 */
export class DescribeDiskCache {
  constructor(
    private readonly cacheDir: string,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  readSObject(orgId: string, name: string): DescribeSObjectProjection | null {
    return this.read<DescribeSObjectProjection>(this.sobjectFile(orgId, name));
  }

  writeSObject(orgId: string, name: string, data: DescribeSObjectProjection): void {
    this.write(orgId, this.sobjectFile(orgId, name), data);
  }

  readGlobal(orgId: string): DescribeGlobalProjection | null {
    return this.read<DescribeGlobalProjection>(this.globalFile(orgId));
  }

  writeGlobal(orgId: string, data: DescribeGlobalProjection): void {
    this.write(orgId, this.globalFile(orgId), data);
  }

  /** Remove a single org's cache, or the whole cache dir when no orgId is given. */
  clear(orgId?: string): void {
    const target = orgId ? path.join(this.cacheDir, this.safe(orgId)) : this.cacheDir;
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private read<T>(file: string): T | null {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const entry = JSON.parse(raw) as CacheEntry<T>;
      if (typeof entry?.cachedAt !== 'number') return null;
      if (Date.now() - entry.cachedAt >= this.ttlMs) return null;
      return entry.data;
    } catch {
      return null;
    }
  }

  private write<T>(orgId: string, file: string, data: T): void {
    try {
      const dir = path.join(this.cacheDir, this.safe(orgId));
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const gitignore = path.join(this.cacheDir, '.gitignore');
      if (!fs.existsSync(gitignore)) {
        fs.writeFileSync(gitignore, '*\n', 'utf8');
      }
      const entry: CacheEntry<T> = { cachedAt: Date.now(), data };
      fs.writeFileSync(file, JSON.stringify(entry), 'utf8');
    } catch {
      // best-effort — never let caching break a run
    }
  }

  private sobjectFile(orgId: string, name: string): string {
    return path.join(this.cacheDir, this.safe(orgId), `sobject_${this.safe(name)}.json`);
  }

  private globalFile(orgId: string): string {
    return path.join(this.cacheDir, this.safe(orgId), 'global.json');
  }

  /** Filesystem-safe token: lowercase, non-alphanumerics → `_`. */
  private safe(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  }
}

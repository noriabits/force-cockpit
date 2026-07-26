// Bounded LRU cache of raw log bodies, shared by the viewer, the noise
// classifier and the AI analyzer so a log is fetched at most once. Cleared on
// org change so bodies never leak across orgs.
const MAX_ENTRIES = 25;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export class LogBodyCache {
  private readonly entries = new Map<string, string>();
  private totalBytes = 0;

  get(logId: string): string | undefined {
    const body = this.entries.get(logId);
    if (body === undefined) return undefined;
    // Refresh recency.
    this.entries.delete(logId);
    this.entries.set(logId, body);
    return body;
  }

  set(logId: string, body: string): void {
    if (this.entries.has(logId)) {
      this.totalBytes -= this.entries.get(logId)!.length;
      this.entries.delete(logId);
    }
    this.entries.set(logId, body);
    this.totalBytes += body.length;
    while (this.entries.size > MAX_ENTRIES || this.totalBytes > MAX_TOTAL_BYTES) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.totalBytes -= this.entries.get(oldest.value)?.length ?? 0;
      this.entries.delete(oldest.value);
    }
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }
}

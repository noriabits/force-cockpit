// Pure display helpers for the Debug Logs tab. DOM-free so they type-check
// under the host tsconfig and can be unit-tested directly.

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / 104857.6) / 10} MB`;
}

export function formatMs(ms: number | null): string {
  if (ms === null || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${Math.round(ms / 100) / 10} s`;
}

/** `HH:mm:ss` in local time — the log list is always "what just happened". */
export function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** `4m 12s` / `1h 03m` — time left before a trace flag expires. */
export function formatCountdown(expirationIso: string, now = Date.now()): string {
  const remaining = new Date(expirationIso).getTime() - now;
  if (Number.isNaN(remaining) || remaining <= 0) return '';
  const totalSeconds = Math.floor(remaining / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

/** A log's status cell: 'Success', or the (shortened) exception text. */
export function shortStatus(status: string, max = 70): string {
  if (!status) return '—';
  return status.length > max ? `${status.slice(0, max)}…` : status;
}

export const DURATION_OPTIONS: { label: string; ms: number }[] = [
  { label: '15 minutes', ms: 15 * 60 * 1000 },
  { label: '30 minutes', ms: 30 * 60 * 1000 },
  { label: '1 hour', ms: 60 * 60 * 1000 },
  { label: '2 hours', ms: 2 * 60 * 60 * 1000 },
  { label: '4 hours', ms: 4 * 60 * 60 * 1000 },
  { label: '8 hours', ms: 8 * 60 * 60 * 1000 },
  { label: '24 hours (max)', ms: 24 * 60 * 60 * 1000 },
];

import { describe, expect, it } from 'vitest';
import { DURATION_OPTIONS, formatBytes, formatCountdown, formatMs, shortStatus } from './format';

describe('formatBytes', () => {
  it('scales to B / KB / MB', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(1_572_864)).toBe('1.5 MB');
  });
});

describe('formatMs', () => {
  it('switches to seconds above a second', () => {
    expect(formatMs(250)).toBe('250 ms');
    expect(formatMs(1500)).toBe('1.5 s');
    expect(formatMs(null)).toBe('—');
  });
});

describe('formatCountdown', () => {
  const now = Date.parse('2026-07-26T09:00:00.000Z');

  it('counts down in hours, minutes and seconds', () => {
    expect(formatCountdown('2026-07-26T10:30:00.000Z', now)).toBe('1h 30m');
    expect(formatCountdown('2026-07-26T09:04:12.000Z', now)).toBe('4m 12s');
    expect(formatCountdown('2026-07-26T09:00:09.000Z', now)).toBe('9s');
  });

  it('returns empty once expired', () => {
    expect(formatCountdown('2026-07-26T08:59:00.000Z', now)).toBe('');
    expect(formatCountdown('not a date', now)).toBe('');
  });
});

describe('shortStatus', () => {
  it('truncates a long exception message', () => {
    expect(shortStatus('Success')).toBe('Success');
    expect(shortStatus('')).toBe('—');
    expect(shortStatus('x'.repeat(100)).endsWith('…')).toBe(true);
  });
});

describe('DURATION_OPTIONS', () => {
  it('never offers more than the 24 hour platform maximum', () => {
    for (const option of DURATION_OPTIONS) {
      expect(option.ms).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    }
  });
});

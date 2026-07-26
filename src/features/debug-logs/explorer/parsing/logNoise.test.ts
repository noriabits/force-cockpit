import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NOISE_OPTIONS,
  isEmptyByContent,
  isEmptyByMetadata,
  resolveNoiseOptions,
} from './logNoise';
import type { ApexLogRow } from '../types';
import { EMPTY_LOG, SUCCESS_LOG } from './__fixtures__/logs';

function row(overrides: Partial<ApexLogRow> = {}): ApexLogRow {
  return {
    id: '07L1',
    logUserId: '005x',
    logUserName: 'Pablo',
    operation: 'ApexTestHandler',
    application: 'Unknown',
    status: 'Success',
    request: 'Api',
    durationMilliseconds: 500,
    logLength: 50_000,
    startTime: '2026-07-26T09:00:00.000+0000',
    ...overrides,
  };
}

describe('isEmptyByMetadata', () => {
  const options = DEFAULT_NOISE_OPTIONS;

  it('keeps a substantial successful log', () => {
    expect(isEmptyByMetadata(row(), options)).toBe(false);
  });

  it('keeps a small, fast log — size is not evidence of emptiness', () => {
    // A useful anonymous-Apex log (a query + five debug lines) is ~1.5 KB and
    // runs in ~8 ms. Hiding those would hide exactly what the user came for.
    expect(isEmptyByMetadata(row({ logLength: 1400, durationMilliseconds: 8 }), options)).toBe(
      false,
    );
  });

  it('hides logs whose operation matches a noise pattern', () => {
    expect(isEmptyByMetadata(row({ operation: '/aura' }), options)).toBe(true);
    expect(isEmptyByMetadata(row({ operation: 'VFRemoting' }), options)).toBe(true);
  });

  it('never hides a failed transaction, however small', () => {
    const failed = row({ logLength: 100, status: 'System.LimitException: Too many SOQL queries' });
    expect(isEmptyByMetadata(failed, options)).toBe(false);
  });

  it('applies the size and duration rules only when configured', () => {
    const sized = resolveNoiseOptions({ maxEmptyBytes: 2048 });
    expect(isEmptyByMetadata(row({ logLength: 1400 }), sized)).toBe(true);
    expect(isEmptyByMetadata(row({ logLength: 9000 }), sized)).toBe(false);

    const timed = resolveNoiseOptions({ maxEmptyDurationMs: 50 });
    expect(isEmptyByMetadata(row({ durationMilliseconds: 8 }), timed)).toBe(true);
    expect(isEmptyByMetadata(row({ durationMilliseconds: 800 }), timed)).toBe(false);
  });

  it('replaces the operation patterns when configured', () => {
    const custom = resolveNoiseOptions({ operationPatterns: ['batch'] });
    expect(isEmptyByMetadata(row({ operation: 'MyBatchJob' }), custom)).toBe(true);
    expect(isEmptyByMetadata(row({ operation: '/aura' }), custom)).toBe(false);
  });
});

describe('isEmptyByContent', () => {
  it('treats a log with only heap and statement chatter as empty', () => {
    expect(isEmptyByContent(EMPTY_LOG)).toBe(true);
  });

  it('keeps a log that has debug output or a query', () => {
    expect(isEmptyByContent(SUCCESS_LOG)).toBe(false);
    expect(isEmptyByContent('x|USER_DEBUG|y')).toBe(false);
    expect(isEmptyByContent('x|DML_BEGIN|y')).toBe(false);
  });

  it('treats a body we could not read as empty only when it is genuinely blank', () => {
    expect(isEmptyByContent('')).toBe(true);
  });
});

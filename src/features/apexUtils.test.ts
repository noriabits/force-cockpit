import { describe, expect, it } from 'vitest';
import { assertApexSuccess, filterUserDebugLines } from './apexUtils';

describe('assertApexSuccess', () => {
  it('does not throw when compiled and success are both true', () => {
    expect(() => assertApexSuccess({ compiled: true, success: true })).not.toThrow();
  });

  it('throws a compilation error when compiled is false', () => {
    expect(() =>
      assertApexSuccess({ compiled: false, success: false, compileProblem: 'Unexpected token' }),
    ).toThrow('Apex compilation error: Unexpected token');
  });

  it('uses "Unknown error" as the compilation message when compileProblem is null', () => {
    expect(() =>
      assertApexSuccess({ compiled: false, success: false, compileProblem: null }),
    ).toThrow('Apex compilation error: Unknown error');
  });

  it('throws an execution error with message and stack trace when both are present', () => {
    expect(() =>
      assertApexSuccess({
        compiled: true,
        success: false,
        exceptionMessage: 'DmlException',
        exceptionStackTrace: 'at AnonymousBlock line 5',
      }),
    ).toThrow('Apex execution error: DmlException\nat AnonymousBlock line 5');
  });

  it('omits the stack trace segment when exceptionStackTrace is null', () => {
    const fn = () =>
      assertApexSuccess({
        compiled: true,
        success: false,
        exceptionMessage: 'DmlException',
        exceptionStackTrace: null,
      });
    expect(fn).toThrow('Apex execution error: DmlException');
    // Verify the newline+stack segment is absent
    try {
      fn();
    } catch (err) {
      expect((err as Error).message).not.toContain('\n');
    }
  });

  it('uses "Unknown error" as the execution message when exceptionMessage is null', () => {
    expect(() =>
      assertApexSuccess({
        compiled: true,
        success: false,
        exceptionMessage: null,
        exceptionStackTrace: null,
      }),
    ).toThrow('Apex execution error: Unknown error');
  });
});

// Helper: builds a realistic Apex debug log line
function debugLine(prefix: string, content: string): string {
  return `10:00:00.1 (1000000)|USER_DEBUG|[1]|DEBUG|${prefix}${content}`;
}

// Helper: builds a log entry that marks the start of a new apex log entry
function logEntry(text: string): string {
  return `10:00:01.0 (2000000)|APEX_CODE|${text}`;
}

describe('filterUserDebugLines', () => {
  it('extracts single-line USER_DEBUG content', () => {
    const log = debugLine('', 'hello world');
    expect(filterUserDebugLines(log)).toBe('hello world');
  });

  it('preserves multiline continuation lines from System.debug()', () => {
    const log = [
      debugLine('', 'Body: {'),
      '  "key" : "value"',
      '}',
      debugLine('', 'after multiline'),
    ].join('\n');
    expect(filterUserDebugLines(log)).toBe('Body: {\n  "key" : "value"\n}\nafter multiline');
  });

  it('stops collecting continuation lines at the next non-USER_DEBUG log entry', () => {
    const log = [
      debugLine('', 'Body: {'),
      '  "key" : "value"',
      '}',
      logEntry('SomeMethod'),
      'should not appear',
    ].join('\n');
    expect(filterUserDebugLines(log)).toBe('Body: {\n  "key" : "value"\n}');
  });

  it('excludes non-USER_DEBUG log entries', () => {
    const log = [
      '10:00:00.1 (1000000)|CODE_UNIT_STARTED|[EXTERNAL]|execute_anonymous_apex',
      debugLine('', 'Response Code: 200'),
      '10:00:01.0 (2000000)|CODE_UNIT_FINISHED|execute_anonymous_apex',
    ].join('\n');
    expect(filterUserDebugLines(log)).toBe('Response Code: 200');
  });

  it('returns empty string for empty log', () => {
    expect(filterUserDebugLines('')).toBe('');
  });

  it('returns empty string for log with no USER_DEBUG lines', () => {
    const log = [
      '10:00:00.1 (1000000)|CODE_UNIT_STARTED|[EXTERNAL]|execute_anonymous_apex',
      '10:00:01.0 (2000000)|CODE_UNIT_FINISHED|execute_anonymous_apex',
    ].join('\n');
    expect(filterUserDebugLines(log)).toBe('');
  });

  it('handles multiple multiline USER_DEBUG blocks', () => {
    const log = [
      debugLine('', 'First: {'),
      '  "a": 1',
      '}',
      debugLine('', 'Second: {'),
      '  "b": 2',
      '}',
    ].join('\n');
    expect(filterUserDebugLines(log)).toBe('First: {\n  "a": 1\n}\nSecond: {\n  "b": 2\n}');
  });
});

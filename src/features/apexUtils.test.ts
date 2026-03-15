import { describe, expect, it } from 'vitest';
import { assertApexSuccess, extractUserDebugLine } from './apexUtils';

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

describe('extractUserDebugLine', () => {
  it('returns the content after the prefix from a matching USER_DEBUG line', () => {
    const log = debugLine('Response Code: ', '200');
    expect(extractUserDebugLine(log, 'Response Code: ')).toBe('200');
  });

  it('returns an empty string when no line matches the prefix', () => {
    const log = debugLine('Response Code: ', '200');
    expect(extractUserDebugLine(log, 'Body: ')).toBe('');
  });

  it('returns an empty string for an empty log', () => {
    expect(extractUserDebugLine('', 'Response Code: ')).toBe('');
  });

  it('collects continuation lines until the next log entry', () => {
    const lines = [
      debugLine('Body: ', '{"line1":'),
      '  "line2": "value"',
      '}',
      logEntry('SomeMethod'),
      'this line should not be included',
    ].join('\n');
    const result = extractUserDebugLine(lines, 'Body: ');
    expect(result).toContain('"line1"');
    expect(result).toContain('"line2"');
    expect(result).not.toContain('SomeMethod');
  });

  it('stops collecting at the next timestamp log entry pattern', () => {
    const lines = [
      debugLine('Body: ', 'first'),
      'continuation',
      logEntry('stops here'),
      'excluded',
    ].join('\n');
    const result = extractUserDebugLine(lines, 'Body: ');
    expect(result).toBe('first\ncontinuation');
  });

  it('handles an empty prefix — returns the full debug content', () => {
    const log = debugLine('', '{"key":"value"}');
    expect(extractUserDebugLine(log, '')).toBe('{"key":"value"}');
  });

  it('uses trimStart so a "Body: " line with empty body still matches the prefix', () => {
    // The debug content is "Body: " — trimStart() leaves trailing space intact
    // so startsWith('Body: ') still succeeds (prefix check uses trimStart, not trim)
    const log = `10:00:00.1 (1000000)|USER_DEBUG|[1]|DEBUG|Body: `;
    expect(extractUserDebugLine(log, 'Body: ')).toBe('');
  });

  it('returns the single-line result when there are no continuation lines', () => {
    const log = [debugLine('Response Code: ', '404'), logEntry('next')].join('\n');
    expect(extractUserDebugLine(log, 'Response Code: ')).toBe('404');
  });
});

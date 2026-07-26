import { describe, expect, it } from 'vitest';
import { isTruncated, parseHeader, parseLine, parseLog, sourceLineOf } from './logLine';
import { FATAL_LOG, HEADER, SUCCESS_LOG, TRUNCATED_LOG } from './__fixtures__/logs';

describe('parseHeader', () => {
  it('reads the api version and captured category levels', () => {
    const header = parseHeader(HEADER);
    expect(header?.apiVersion).toBe('65.0');
    expect(header?.levels.APEX_CODE).toBe('DEBUG');
    expect(header?.levels.DB).toBe('INFO');
  });

  it('returns null for a non-header line', () => {
    expect(parseHeader('09:00:00.1 (1000000)|EXECUTION_STARTED')).toBeNull();
  });
});

describe('parseLine', () => {
  it('splits timestamp, nanos, event and fields', () => {
    const event = parseLine('09:00:00.1 (7000000)|USER_DEBUG|[14]|DEBUG|loaded 10 accounts', 7);
    expect(event.time).toBe('09:00:00.1');
    expect(event.nanos).toBe(7000000);
    expect(event.event).toBe('USER_DEBUG');
    expect(event.fields).toEqual(['[14]', 'DEBUG', 'loaded 10 accounts']);
    expect(event.lineNo).toBe(7);
  });

  it('tolerates a trailing carriage return', () => {
    // Salesforce serves log bodies with CRLF. `.` does not match `\r` in JS, so
    // without stripping it the whole log parses as continuation lines and every
    // detector sees nothing.
    const event = parseLine('09:00:00.1 (7000000)|USER_DEBUG|[14]|DEBUG|hi\r', 7);
    expect(event.event).toBe('USER_DEBUG');
    expect(event.fields).toEqual(['[14]', 'DEBUG', 'hi']);
    expect(event.raw.endsWith('\r')).toBe(false);
  });

  it('treats a line without the timestamp prefix as a continuation', () => {
    const event = parseLine('Class.OrderService.calculate: line 42, column 1', 9);
    expect(event.event).toBe('');
    expect(event.nanos).toBeNull();
    expect(event.raw).toContain('OrderService');
  });
});

describe('parseLog', () => {
  it('keeps line numbers aligned with the raw text', () => {
    const { events, header } = parseLog(SUCCESS_LOG);
    expect(header?.apiVersion).toBe('65.0');
    expect(events).toHaveLength(SUCCESS_LOG.split('\n').length);
    expect(events[0].lineNo).toBe(1);
    expect(events[events.length - 1].event).toBe('EXECUTION_FINISHED');
  });

  it('parses a CRLF body identically to an LF one', () => {
    const lf = parseLog(SUCCESS_LOG);
    const crlf = parseLog(SUCCESS_LOG.split('\n').join('\r\n'));
    expect(crlf.header?.apiVersion).toBe(lf.header?.apiVersion);
    expect(crlf.events.map((e) => e.event)).toEqual(lf.events.map((e) => e.event));
    expect(crlf.events).toHaveLength(lf.events.length);
  });

  it('parses stack frames as continuation lines of the FATAL_ERROR', () => {
    const { events } = parseLog(FATAL_LOG);
    const fatalIndex = events.findIndex((e) => e.event === 'FATAL_ERROR');
    expect(events[fatalIndex + 1].event).toBe('');
    expect(events[fatalIndex + 1].raw).toContain('line 42');
  });
});

describe('isTruncated', () => {
  it('detects the truncation marker', () => {
    expect(isTruncated(TRUNCATED_LOG)).toBe(true);
    expect(isTruncated(SUCCESS_LOG)).toBe(false);
  });
});

describe('sourceLineOf', () => {
  it('reads the [42] marker and ignores [EXTERNAL]', () => {
    expect(sourceLineOf(parseLine('09:00:00.1 (1)|SOQL_EXECUTE_BEGIN|[42]|x', 1))).toBe(42);
    expect(sourceLineOf(parseLine('09:00:00.1 (1)|CODE_UNIT_STARTED|[EXTERNAL]|x', 1))).toBeNull();
  });
});

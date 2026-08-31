// Pure debug-log tokenizer.
//
// A debug log starts with a header line (`65.0 APEX_CODE,DEBUG;DB,INFO;…`) and
// then a stream of pipe-delimited lines:
//   `HH:mm:ss.SSS (nanosSinceRequestStart)|EVENT|field|field…`
// Anything without that prefix is a continuation of the previous line (multi-line
// System.debug output, stack frames, limit blocks), and is kept as an event with
// an empty identifier so line numbers always line up with the raw text.
import type { LogEvent, LogHeader, LogLevel } from '../types';

const LINE_RE = /^(\d{2}:\d{2}:\d{2}\.\d+)\s\((\d+)\)\|(.*)$/;
const HEADER_RE = /^(\d+\.\d+)\s+([A-Z_]+,[A-Z]+(?:;[A-Z_]+,[A-Z]+)*)\s*$/;

const TRUNCATION_MARKER = 'MAXIMUM DEBUG LOG SIZE REACHED';

/** Parse the first line of a log into its API version and captured category levels. */
export function parseHeader(firstLine: string): LogHeader | null {
  const match = HEADER_RE.exec(firstLine.trim());
  if (!match) return null;
  const levels: Record<string, LogLevel> = {};
  for (const pair of match[2].split(';')) {
    const [category, level] = pair.split(',');
    if (category && level) levels[category] = level as LogLevel;
  }
  return { apiVersion: match[1], levels, raw: firstLine.trim() };
}

/**
 * Parse one line. `lineNo` is 1-based so it can be shown and jumped to directly.
 *
 * A trailing carriage return is stripped first: Salesforce serves log bodies
 * with CRLF, and in JavaScript `.` does not match `\r` (it is a line
 * terminator), so `(.*)$` would never match and EVERY line would be
 * misclassified as a continuation — no events, no issues, no summary.
 */
export function parseLine(rawLine: string, lineNo: number): LogEvent {
  const raw = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
  const match = LINE_RE.exec(raw);
  if (!match) {
    return { lineNo, time: '', nanos: null, event: '', fields: [], raw };
  }
  const parts = match[3].split('|');
  return {
    lineNo,
    time: match[1],
    nanos: Number(match[2]),
    event: parts[0] ?? '',
    fields: parts.slice(1),
    raw,
  };
}

/** Tokenize a whole log body. Handles both LF and CRLF bodies. */
export function parseLog(body: string): { header: LogHeader | null; events: LogEvent[] } {
  const lines = body.split(/\r?\n/);
  const header = lines.length > 0 ? parseHeader(lines[0]) : null;
  const events = lines.map((raw, i) => parseLine(raw, i + 1));
  return { header, events };
}

/** True when Salesforce cut the log short at the 20 MB budget. */
export function isTruncated(body: string): boolean {
  return body.includes(TRUNCATION_MARKER);
}

/**
 * The `[42]` source-line marker most events carry as their first field.
 * Returns null for `[EXTERNAL]` and anything unparseable.
 */
export function sourceLineOf(event: LogEvent): number | null {
  const first = event.fields[0];
  if (!first) return null;
  const match = /^\[(\d+)\]$/.exec(first);
  return match ? Number(match[1]) : null;
}

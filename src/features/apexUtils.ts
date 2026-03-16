export function assertApexSuccess(result: {
  compiled: boolean;
  success: boolean;
  compileProblem?: string | null;
  exceptionMessage?: string | null;
  exceptionStackTrace?: string | null;
}): void {
  if (!result.compiled) {
    throw new Error('Apex compilation error: ' + (result.compileProblem || 'Unknown error'));
  }
  if (!result.success) {
    throw new Error(
      'Apex execution error: ' +
        (result.exceptionMessage || 'Unknown error') +
        (result.exceptionStackTrace ? '\n' + result.exceptionStackTrace : ''),
    );
  }
}

/**
 * Extracts a USER_DEBUG line from an Apex debug log that starts with a prefix.
 * @param debugLog - Complete debug log string
 * @param prefix - Prefix to search for (e.g., "Response Code: ")
 * @returns Content after the prefix, or empty string if not found
 */
export function extractUserDebugLine(debugLog: string, prefix: string): string {
  const lines = debugLog.split('\n');
  // Apex log entries start with a timestamp like "HH:MM:SS.N (nanos)|"
  const logEntryPattern = /^\d+:\d+:\d+\.\d+ \(\d+\)\|/;

  const matchIndex = lines.findIndex((line) => {
    if (!line.includes('|USER_DEBUG|')) return false;
    const debugContent = line.split('|DEBUG|')[1];
    // Use trimStart() not trim() — trim() would strip the trailing space from
    // lines like "Body: " (empty body) making startsWith('Body: ') fail.
    return debugContent !== undefined && debugContent.trimStart().startsWith(prefix);
  });

  if (matchIndex === -1) return '';

  const firstLineContent =
    lines[matchIndex].split('|DEBUG|')[1]?.trim().substring(prefix.length) ?? '';

  // Collect continuation lines until the next log entry
  const continuation: string[] = [];
  for (let i = matchIndex + 1; i < lines.length; i++) {
    if (logEntryPattern.test(lines[i])) break;
    continuation.push(lines[i]);
  }

  return continuation.length > 0
    ? firstLineContent + '\n' + continuation.join('\n')
    : firstLineContent;
}

/**
 * Filters an Apex debug log to show only USER_DEBUG content,
 * preserving multiline continuation lines (e.g. JSON bodies from System.debug()).
 * @param log - Complete debug log string
 * @returns Filtered log containing only USER_DEBUG content
 */
export function filterUserDebugLines(log: string): string {
  const lines = log.split('\n');
  const result: string[] = [];
  let inUserDebug = false;

  for (const line of lines) {
    const isNewLogEntry = /^\d{2}:\d{2}:\d{2}\.\d+ \(\d+\)\|/.test(line);
    if (isNewLogEntry) {
      inUserDebug = line.includes('|USER_DEBUG|');
      if (inUserDebug) {
        const debugIdx = line.indexOf('|DEBUG|');
        result.push(debugIdx !== -1 ? line.slice(debugIdx + 7) : line);
      }
    } else if (inUserDebug) {
      result.push(line);
    }
  }

  return result.join('\n');
}

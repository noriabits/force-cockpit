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

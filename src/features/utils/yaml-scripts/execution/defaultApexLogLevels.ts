import type { DebuggingOptions } from '../../../../salesforce/connection';

/**
 * Log levels for Apex run through this feature (script execution + AI gather).
 *
 * `executeAnonymousWithDebugLog` always attaches a SOAP DebuggingHeader, and a
 * caller-supplied DebuggingHeader takes precedence over any TraceFlag active on
 * the user for that specific call — so whatever is set here is what the log
 * actually contains, regardless of a trace flag configured in the Debug Logs
 * tab. Mirrors the "USER_DEBUG only" debug-level preset: just the script's own
 * System.debug output plus unhandled exceptions, nothing else.
 */
export const DEFAULT_APEX_LOG_LEVELS: DebuggingOptions['logLevels'] = {
  Apex_code: 'DEBUG',
  Apex_profiling: 'NONE',
  Callout: 'NONE',
  Db: 'NONE',
  System: 'ERROR',
  Validation: 'NONE',
  Visualforce: 'NONE',
  Workflow: 'NONE',
};

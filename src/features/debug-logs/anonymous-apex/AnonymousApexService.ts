// Runs one ad-hoc Execute Anonymous for the ▶️ Apex tab and parses its log with
// the Debug Logs tab's own pipeline. vscode-free.
//
// Deliberately NOT `assertApexSuccess`: that throws on a compile error or an
// uncaught exception, and either one is precisely when the user needs the log
// and the line number. Both come back as an ordinary outcome instead; only the
// call itself failing (not connected, a SOAP fault, the network) is an error.
import type { ConnectionManager, DebuggingOptions } from '../../../salesforce/connection';
import type { AnonymousApexOutcome } from '../../../shared/protocol';
import { raceAbort } from '../../../utils/abort';
import { RECOMMENDED_PRESET_ID, findPreset } from '../explorer/debugLevelPresets';
import { analyzeLog } from '../explorer/parsing/analyzeLog';
import type { CategoryLevels } from '../explorer/types';

/**
 * A preset's TraceFlag/DebugLevel category names → the SOAP DebuggingHeader's.
 * The header is what governs this call's log (it overrides any active TraceFlag
 * — see CLAUDE.md, Debug Logs "Salesforce facts"), so the picker has to land
 * here, not on a DebugLevel record.
 */
export function toSoapLogLevels(levels: CategoryLevels): DebuggingOptions['logLevels'] {
  return {
    Apex_code: levels.ApexCode,
    Apex_profiling: levels.ApexProfiling,
    Callout: levels.Callout,
    Db: levels.Database,
    System: levels.System,
    Validation: levels.Validation,
    Visualforce: levels.Visualforce,
    Workflow: levels.Workflow,
  };
}

export class AnonymousApexService {
  constructor(private readonly connectionManager: ConnectionManager) {}

  /**
   * Execute `code` with the preset's log levels. A cancel stops waiting at once
   * (`raceAbort`), but Apex has no server-side cancel: the transaction may still
   * complete, and the webview says so.
   */
  async execute(
    code: string,
    presetId: string,
    signal?: AbortSignal,
  ): Promise<AnonymousApexOutcome> {
    if (!code.trim()) throw new Error('Nothing to execute.');
    const preset = findPreset(presetId) ?? findPreset(RECOMMENDED_PRESET_ID)!;
    const result = await raceAbort(
      this.connectionManager.executeAnonymousWithDebugLog(code, {
        logLevels: toSoapLogLevels(preset.levels),
      }),
      signal,
    );
    return {
      compiled: result.compiled,
      success: result.success,
      compileProblem: result.compileProblem,
      line: result.line ?? null,
      column: result.column ?? null,
      exceptionMessage: result.exceptionMessage,
      exceptionStackTrace: result.exceptionStackTrace,
      log: result.debugLog ? this.parse(result.debugLog) : null,
    };
  }

  private parse(body: string): NonNullable<AnonymousApexOutcome['log']> {
    const { partial, totalLines, parsed } = analyzeLog(body);
    return { body: partial ? '' : body, partial, totalLines, ...parsed };
  }
}

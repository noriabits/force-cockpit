import type { ConnectionManager } from '../../../../salesforce/connection';
import { assertApexSuccess, filterUserDebugLines } from '../../../../services/apex/apexUtils';
import type { ExecuteScriptResult, YamlScript } from '../types';
import { DEFAULT_APEX_LOG_LEVELS } from './defaultApexLogLevels';

export class ApexExecutor {
  constructor(private readonly connectionManager: ConnectionManager) {}

  async execute(script: YamlScript): Promise<ExecuteScriptResult> {
    try {
      const apexResult = await this.connectionManager.executeAnonymousWithDebugLog(script.script, {
        logLevels: DEFAULT_APEX_LOG_LEVELS,
      });
      assertApexSuccess(apexResult);
      const debugLog = apexResult.debugLog ?? '';
      return {
        scriptId: script.id,
        success: true,
        message: `Script "${script.name}" executed successfully.`,
        debugLog,
        filteredDebugLog: filterUserDebugLines(debugLog),
      };
    } catch (err) {
      return {
        scriptId: script.id,
        success: false,
        message: (err as Error).message,
        debugLog: '',
      };
    }
  }
}

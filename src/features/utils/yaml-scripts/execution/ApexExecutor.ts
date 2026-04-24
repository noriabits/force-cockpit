import type { ConnectionManager } from '../../../../salesforce/connection';
import { assertApexSuccess, filterUserDebugLines } from '../../../apexUtils';
import type { ExecuteScriptResult, YamlScript } from '../types';

export class ApexExecutor {
  constructor(private readonly connectionManager: ConnectionManager) {}

  async execute(script: YamlScript): Promise<ExecuteScriptResult> {
    try {
      const apexResult = await this.connectionManager.executeAnonymousWithDebugLog(script.script, {
        logLevels: { Apex_code: 'DEBUG' },
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

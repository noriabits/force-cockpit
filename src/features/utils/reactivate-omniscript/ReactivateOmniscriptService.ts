import type { ConnectionManager } from '../../../salesforce/connection';
import { assertApexSuccess } from '../../apexUtils';

export interface OmniscriptRecord {
  Id: string;
  Type: string;
  SubType: string;
  Language: string;
}

export interface ReactivateResult {
  message: string;
}

export class ReactivateOmniscriptService {
  constructor(private readonly connectionManager: ConnectionManager) {}

  async fetchOmniscripts(): Promise<OmniscriptRecord[]> {
    const soql =
      `SELECT Id, vlocity_cmt__Type__c, vlocity_cmt__SubType__c, vlocity_cmt__Language__c ` +
      `FROM vlocity_cmt__OmniScript__c ` +
      `WHERE vlocity_cmt__IsActive__c = true AND vlocity_cmt__IsProcedure__c = false ` +
      `ORDER BY vlocity_cmt__Type__c, vlocity_cmt__SubType__c`;

    const result = await this.connectionManager.query<{
      Id: string;
      vlocity_cmt__Type__c: string;
      vlocity_cmt__SubType__c: string;
      vlocity_cmt__Language__c: string;
    }>(soql);

    return (result.records || []).map((r) => ({
      Id: r.Id,
      Type: r.vlocity_cmt__Type__c || '—',
      SubType: r.vlocity_cmt__SubType__c || '—',
      Language: r.vlocity_cmt__Language__c || '—',
    }));
  }

  async reactivate(omniscriptId: string): Promise<ReactivateResult> {
    const apex = `vlocity_cmt.BusinessProcessController.bulkActivateBP(new List<Id> { '${omniscriptId}' });`;

    const result = await this.connectionManager.executeAnonymous(apex);
    assertApexSuccess(result);

    return { message: 'OmniScript reactivated successfully.' };
  }
}

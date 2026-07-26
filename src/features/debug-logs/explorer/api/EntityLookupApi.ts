// Finds the things a trace flag can point at: the current user, the system
// users (Automated Process / Platform Integration — the ones Setup cannot
// trace), any user by name, and Apex classes/triggers for class tracing.
import type { ConnectionManager } from '../../../../salesforce/connection';
import type { TraceEntity } from '../types';
import { soqlEscape, ToolingRest } from './ToolingRest';

/** UserTypes that represent platform/system users rather than people. */
const SYSTEM_USER_TYPES = ['AutomatedProcess', 'PlatformIntegration'];

export class EntityLookupApi {
  constructor(
    private readonly rest: ToolingRest,
    private readonly connectionManager: ConnectionManager,
  ) {}

  /** The connected user, resolved from the org username. */
  async currentUser(): Promise<TraceEntity | null> {
    const username = this.connectionManager.getCurrentOrg()?.username;
    if (!username) return null;
    const records = await this.rest.queryData<{ Id: string; Name: string; Username: string }>(
      `SELECT Id, Name, Username FROM User WHERE Username = '${soqlEscape(username)}' LIMIT 1`,
    );
    if (records.length === 0) return null;
    return {
      id: records[0].Id,
      name: records[0].Name,
      subtitle: records[0].Username,
      kind: 'user',
    };
  }

  /**
   * Automated Process and other platform users. Async work (platform-event
   * triggers, resumed flows, batch retries) logs under these, separately from
   * the user who triggered it.
   */
  async systemUsers(): Promise<TraceEntity[]> {
    const types = SYSTEM_USER_TYPES.map((t) => `'${t}'`).join(', ');
    const records = await this.rest.queryData<{
      Id: string;
      Name: string;
      Username: string;
      UserType: string;
    }>(`SELECT Id, Name, Username, UserType FROM User WHERE UserType IN (${types}) ORDER BY Name`);
    return records.map((r) => ({
      id: r.Id,
      name: r.Name,
      subtitle: `${r.Username} · ${r.UserType}`,
      kind: 'user' as const,
      system: true,
    }));
  }

  async searchUsers(term: string): Promise<TraceEntity[]> {
    const q = soqlEscape(term.trim());
    if (!q) return [];
    const records = await this.rest.queryData<{
      Id: string;
      Name: string;
      Username: string;
      IsActive: boolean;
    }>(
      'SELECT Id, Name, Username, IsActive FROM User ' +
        `WHERE Name LIKE '%${q}%' OR Username LIKE '%${q}%' ORDER BY Name LIMIT 25`,
    );
    return records.map((r) => ({
      id: r.Id,
      name: r.Name,
      subtitle: r.IsActive ? r.Username : `${r.Username} (inactive)`,
      kind: 'user' as const,
    }));
  }

  /** Apex classes and triggers, for a CLASS_TRACING flag. */
  async searchApexEntities(term: string): Promise<TraceEntity[]> {
    const q = soqlEscape(term.trim());
    if (!q) return [];
    const [classes, triggers] = await Promise.all([
      this.rest.query<{ Id: string; Name: string; NamespacePrefix: string | null }>(
        `SELECT Id, Name, NamespacePrefix FROM ApexClass WHERE Name LIKE '%${q}%' ORDER BY Name LIMIT 15`,
      ),
      this.rest.query<{ Id: string; Name: string; TableEnumOrId: string | null }>(
        `SELECT Id, Name, TableEnumOrId FROM ApexTrigger WHERE Name LIKE '%${q}%' ORDER BY Name LIMIT 15`,
      ),
    ]);
    return [
      ...classes.map((c) => ({
        id: c.Id,
        name: c.Name,
        subtitle: c.NamespacePrefix ? `Apex class · ${c.NamespacePrefix}` : 'Apex class',
        kind: 'apexClass' as const,
      })),
      ...triggers.map((t) => ({
        id: t.Id,
        name: t.Name,
        subtitle: t.TableEnumOrId ? `Trigger on ${t.TableEnumOrId}` : 'Apex trigger',
        kind: 'apexTrigger' as const,
      })),
    ];
  }
}

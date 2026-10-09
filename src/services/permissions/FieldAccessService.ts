import type { ConnectionManager } from '../../salesforce/connection';

/** One field as the Tooling API's FieldDefinition reports it (NOT FLS-filtered). */
export interface FieldDefinitionRow extends Record<string, unknown> {
  QualifiedApiName: string;
  Label: string | null;
  DataType: string | null;
}

/**
 * One FieldPermissions row, standard (non-Tooling) API. `Parent` is the owning
 * PermissionSet. A `PermissionSetGroupId` on THAT record (not on the group itself)
 * means it is the hidden "aggregate" PermissionSet Salesforce auto-generates to
 * represent a Permission Set Group's combined access — `PermissionSetGroup` is
 * only populated in that case.
 */
interface FieldPermissionRow extends Record<string, unknown> {
  Field: string;
  Parent: {
    Name: string;
    PermissionSetGroupId: string | null;
    PermissionSetGroup: { MasterLabel: string } | null;
  };
}

/** API names are interpolated into SOQL string literals — validate, never escape. */
const SAFE_IDENTIFIER = /^[A-Za-z0-9_]+$/;

/** Cap on how many permission-set names are listed for one field. */
const MAX_GRANTS_SHOWN = 15;

/**
 * The org-side facts behind "why can't I see / edit this field", shared by the
 * SOQL tab's error diagnostics and the Record Detail:
 *
 *   - `fieldDefinitions` — every field defined on an object, from the Tooling
 *     API's FieldDefinition, which (unlike `describeSObject`) is NOT FLS-filtered.
 *     Diffing it against a describe is how a field hidden by field-level security
 *     is told apart from one that does not exist.
 *   - `grants` — which permission sets / permission set groups grant Read or Edit
 *     on a set of fields, so the fix is "assign PSG X" rather than "ask an admin
 *     and hope". Profiles are excluded: they are not something a user can ask to
 *     be assigned.
 *
 * Best-effort throughout. Both queries need "View Setup and Configuration"; a
 * failure resolves `null` — distinct from an empty answer — and never throws.
 * vscode-free.
 */
export class FieldAccessService {
  /** Keyed `${orgId}:${entity}` — an org switch misses naturally, no invalidation hook. */
  private definitionCache = new Map<string, FieldDefinitionRow[]>();

  constructor(private readonly connectionManager: ConnectionManager) {}

  private orgKey(): string {
    return this.connectionManager.getCurrentOrg()?.orgId ?? 'none';
  }

  /**
   * Every field defined on the entity, FLS or not. `null` when the Tooling query is
   * unavailable (missing setup permission, no connection, unknown entity).
   */
  async fieldDefinitions(entity: string): Promise<FieldDefinitionRow[] | null> {
    if (!SAFE_IDENTIFIER.test(entity)) return null;

    const key = `${this.orgKey()}:${entity.toLowerCase()}`;
    const cached = this.definitionCache.get(key);
    if (cached) return cached;

    try {
      const result = await this.connectionManager.toolingQuery<FieldDefinitionRow>(
        `SELECT QualifiedApiName, Label, DataType FROM FieldDefinition ` +
          `WHERE EntityDefinition.QualifiedApiName = '${entity}' LIMIT 2000`,
      );
      const rows = (result.records ?? []).filter((r) => !!r.QualifiedApiName);
      if (rows.length === 0) return null;
      this.definitionCache.set(key, rows);
      return rows;
    } catch {
      return null;
    }
  }

  /**
   * Who grants `access` on each of `fields` (API names, without the object prefix).
   * The map is keyed by the LOWERCASED field name, and a field nobody grants is
   * simply absent from it. `null` when the lookup itself failed. One query for
   * the whole batch — the Record Detail asks about every restricted field of a
   * record at once.
   */
  async grants(
    entity: string,
    fields: string[],
    access: 'read' | 'edit',
  ): Promise<Map<string, string[]> | null> {
    const safe = fields.filter((f) => SAFE_IDENTIFIER.test(f));
    if (!SAFE_IDENTIFIER.test(entity)) return null;
    if (safe.length === 0) return new Map();

    const flag = access === 'edit' ? 'PermissionsEdit' : 'PermissionsRead';
    const list = safe.map((f) => `'${entity}.${f}'`).join(', ');
    try {
      const result = await this.connectionManager.query<FieldPermissionRow>(
        `SELECT Field, Parent.Name, Parent.PermissionSetGroupId, ` +
          `Parent.PermissionSetGroup.MasterLabel ` +
          `FROM FieldPermissions ` +
          `WHERE SObjectType = '${entity}' AND Field IN (${list}) ` +
          `AND Parent.IsOwnedByProfile = false AND ${flag} = true ` +
          `ORDER BY Field, Parent.Name LIMIT 2000`,
      );
      return groupByField(result.records ?? []);
    } catch {
      return null;
    }
  }
}

function groupByField(rows: FieldPermissionRow[]): Map<string, string[]> {
  const byField = new Map<string, string[]>();
  for (const row of rows) {
    const field = (row.Field ?? '').split('.').pop()?.toLowerCase();
    if (!field) continue;
    const sources = byField.get(field) ?? [];
    const source = describeGrantSource(row);
    if (!sources.includes(source) && sources.length < MAX_GRANTS_SHOWN) sources.push(source);
    byField.set(field, sources);
  }
  return byField;
}

/** "Sales_Ops_Extended (Permission Set)" / "Field_Access (Permission Set Group)". */
function describeGrantSource(row: FieldPermissionRow): string {
  if (row.Parent.PermissionSetGroupId) {
    const label = row.Parent.PermissionSetGroup?.MasterLabel ?? row.Parent.Name;
    return `${label} (Permission Set Group)`;
  }
  return `${row.Parent.Name} (Permission Set)`;
}

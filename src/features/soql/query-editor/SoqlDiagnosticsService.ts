import type { ConnectionManager } from '../../../salesforce/connection';
import type { DescribeService } from '../../../services/describe/DescribeService';
import { parseSoqlError, fromObjectOfQuery } from './soqlErrorParser';
import { suggestNames } from './nameSuggest';
import { FieldAccessService } from '../../../services/permissions/FieldAccessService';

/**
 * Extra findings appended below the verbatim Salesforce error in the SOQL tab's
 * results area. Purely additive — the raw SF message is never altered or replaced.
 */
export interface SoqlDiagnostic {
  severity: 'warning' | 'info';
  title: string;
  detail: string;
  suggestions?: string[];
  /** Permission sets / permission set groups that would grant the missing access. */
  grantedBy?: string[];
}

/** API names are interpolated into SOQL string literals — validate, never escape. */
const SAFE_IDENTIFIER = /^[A-Za-z0-9_]+$/;

/**
 * Explains *why* a SOQL query failed, beyond what Salesforce says.
 *
 * The case this exists for: `describeSObject` is itself FLS-filtered, so a field
 * the running user cannot read is simply absent from the describe response — and
 * SOQL reports it as `No such column`, indistinguishable from a typo. The Tooling
 * API's `FieldDefinition` is NOT FLS-filtered, so comparing the two tells us
 * whether the field genuinely does not exist or merely is not visible.
 *
 * When a field is hidden by FLS, it also queries `FieldPermissions` (standard
 * API — every field/object grant a profile or permission set makes is a row
 * there) to name which permission set or permission set group, if any, would
 * grant Read — so the fix is "assign PSG X" rather than "ask an admin and hope".
 *
 * Everything here is best-effort. `FieldDefinition`/`FieldPermissions` need "View
 * Setup and Configuration"; without it the query throws and diagnosis quietly
 * degrades (describe-only suggestions; no permission-set names). `diagnose`
 * never throws and never changes the outcome of the query itself.
 *
 * Every describe lookup here uses `describeService`'s `*Fresh` methods, never
 * the cached ones. `DescribeService`'s normal cache is fine for autocomplete —
 * schema and permissions rarely change mid-session — but diagnosis exists
 * specifically to answer "can I read this right now", often run moments after an
 * admin just changed that exact permission. A cache hit from before the change
 * would report the field as visible and print the wrong verdict ("readable by
 * your user") for the one case (FLS was just revoked) this feature exists to catch.
 */
export class SoqlDiagnosticsService {
  /** FieldDefinition (the full, non-FLS-filtered field list) + FieldPermissions grants. */
  private readonly fieldAccess: FieldAccessService;

  constructor(
    private readonly connectionManager: ConnectionManager,
    private readonly describeService: DescribeService,
  ) {
    this.fieldAccess = new FieldAccessService(connectionManager);
  }

  async diagnose(soql: string, errorMessage: string): Promise<SoqlDiagnostic[]> {
    try {
      const info = parseSoqlError(errorMessage);
      if (!info) return [];

      if (info.kind === 'unknown-field') {
        return await this.diagnoseField(info.entity, info.field);
      }
      if (info.kind === 'unknown-relationship') {
        return await this.diagnoseRelationship(soql, info.relationship);
      }
      return await this.diagnoseObject(info.object);
    } catch {
      // Diagnosis is an extra: never let it turn a query error into a worse one.
      return [];
    }
  }

  // ── Fields ──────────────────────────────────────────────────────────────────

  private async diagnoseField(entity: string, field: string): Promise<SoqlDiagnostic[]> {
    const visible = await this.visibleFields(entity);

    if (visible.some((f) => f.toLowerCase() === field.toLowerCase())) {
      return [
        {
          severity: 'info',
          title: `'${field}' is readable by your user`,
          detail:
            `The field exists on ${entity} and you have access to it, so the failure is ` +
            `contextual — check the object in the FROM clause, or whether the field needs ` +
            `a relationship prefix (it may live on a related object).`,
        },
      ];
    }

    const all = await this.fieldAccess.fieldDefinitions(entity);

    if (all) {
      const match = all.find((f) => f.QualifiedApiName.toLowerCase() === field.toLowerCase());
      if (match) {
        const describedAs = [match.Label, match.DataType].filter(Boolean).join(', ');
        const byField = await this.fieldAccess.grants(entity, [match.QualifiedApiName], 'read');
        const grants = byField ? (byField.get(match.QualifiedApiName.toLowerCase()) ?? []) : null;
        const grantedBy = grants ?? undefined;

        let adminAction: string;
        if (!grants) {
          adminAction = 'Ask an admin to grant Read on this field via a profile or permission set.';
        } else if (grants.length === 0) {
          adminAction =
            'No permission set or permission set group currently grants Read on this field ' +
            'either — an admin will need to add it to one.';
        } else {
          adminAction =
            'Ask an admin to assign you one of the permission sets below, or add Read access ' +
            'to this field on one you already have.';
        }

        return [
          {
            severity: 'warning',
            title: `'${match.QualifiedApiName}' exists but field-level security is hiding it`,
            detail:
              `The field is defined on ${entity}${describedAs ? ` (${describedAs})` : ''}, but ` +
              `your user has no Read access to it. Salesforce reports hidden fields as ` +
              `"No such column", so this is a permission problem, not a typo. ${adminAction}`,
            ...(grantedBy && grantedBy.length > 0 ? { grantedBy } : {}),
          },
        ];
      }
    }

    const candidates = all ? all.map((f) => f.QualifiedApiName) : visible;
    const suggestions = suggestNames(field, candidates);
    return [
      {
        severity: 'info',
        title: `No field named '${field}' on ${entity}`,
        detail: all
          ? `Checked every field defined on ${entity}, including ones hidden from you — ` +
            `there is no such field.`
          : `Checked the fields visible to you on ${entity}. (The full field list needs the ` +
            `"View Setup and Configuration" permission, so a field hidden by field-level ` +
            `security could not be ruled out.)`,
        ...(suggestions.length ? { suggestions } : {}),
      },
    ];
  }

  /** Field API names the running user can actually see (FLS-filtered by Salesforce). */
  private async visibleFields(entity: string): Promise<string[]> {
    try {
      const described = await this.describeService.describeSObjectFresh(entity);
      return described.fields.map((f) => f.name);
    } catch {
      return [];
    }
  }

  // ── Relationships ───────────────────────────────────────────────────────────

  private async diagnoseRelationship(
    soql: string,
    relationship: string,
  ): Promise<SoqlDiagnostic[]> {
    const entity = fromObjectOfQuery(soql);
    if (!entity) return [];

    let names: string[];
    try {
      const described = await this.describeService.describeSObjectFresh(entity);
      names = described.fields.map((f) => f.relationshipName).filter((n): n is string => !!n);
    } catch {
      return [];
    }

    const suggestions = suggestNames(relationship, names);
    return [
      {
        severity: 'info',
        title: `'${relationship}' is not a relationship on ${entity}`,
        detail:
          `Parent relationships are traversed by their relationship name, which for a ` +
          `custom lookup ends in __r (not __c). Child relationships need a sub-query.`,
        ...(suggestions.length ? { suggestions } : {}),
      },
    ];
  }

  // ── Objects ─────────────────────────────────────────────────────────────────

  private async diagnoseObject(object: string): Promise<SoqlDiagnostic[]> {
    let visible: string[] = [];
    try {
      const global = await this.describeService.describeGlobalFresh();
      visible = global.sobjects.map((s) => s.name);
    } catch {
      /* fall through — suggestions are optional */
    }

    if (visible.some((n) => n.toLowerCase() === object.toLowerCase())) {
      return [
        {
          severity: 'info',
          title: `'${object}' exists but the query was rejected`,
          detail:
            `The object is visible to you, so check the query syntax — a sub-query needs the ` +
            `child relationship name rather than the object name.`,
        },
      ];
    }

    if (await this.objectExists(object)) {
      return [
        {
          severity: 'warning',
          title: `'${object}' exists but you have no access to it`,
          detail:
            `The object is defined in this org but is not among the objects your user can ` +
            `see, so SOQL reports it as unsupported. Ask an admin to grant Read on the ` +
            `object via a profile or permission set.`,
        },
      ];
    }

    const suggestions = suggestNames(object, visible);
    return [
      {
        severity: 'info',
        title: `No object named '${object}' in this org`,
        detail: `Custom objects need the __c suffix; a managed package object also needs its namespace prefix.`,
        ...(suggestions.length ? { suggestions } : {}),
      },
    ];
  }

  /** Whether the object is defined at all, regardless of the user's object permissions. */
  private async objectExists(object: string): Promise<boolean> {
    if (!SAFE_IDENTIFIER.test(object)) return false;
    try {
      const result = await this.connectionManager.toolingQuery(
        `SELECT QualifiedApiName FROM EntityDefinition WHERE QualifiedApiName = '${object}' LIMIT 1`,
      );
      return (result.records ?? []).length > 0;
    } catch {
      return false;
    }
  }
}

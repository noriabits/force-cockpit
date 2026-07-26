// Org-facing tools offered to the model: schema lookup and read-only SOQL.
// Both are host-executed — the model can only propose a call.
import type { ConnectionManager } from '../../../salesforce/connection';
import type { DescribeService } from '../../describe/DescribeService';
import { stripRecordAttributes } from '../../../utils/salesforce';
import { boolArg, stringArg, type ToolHandler } from './ToolHandler';

export function recordsToJson(records: unknown[]): string {
  return JSON.stringify(stripRecordAttributes(records), null, 2);
}

/**
 * `get_current_user` — the Salesforce username the model is connected as. No org
 * round-trip: `ConnectionManager` already holds this from the active session.
 * Exists because the model otherwise has no way to know who "I"/"my user" means
 * in a question — e.g. "do I have access to this field" — and describe_object's
 * results are themselves already filtered to exactly this user's field-level
 * security, which is meaningless to state without saying whose it is.
 */
export function createCurrentUserTool(connectionManager: ConnectionManager): ToolHandler {
  return {
    spec: {
      name: 'get_current_user',
      description:
        'Get the Salesforce username of the user you are currently connected as. Call this ' +
        'whenever a question refers to "I"/"me"/"my" access, permissions, or field visibility ' +
        '— e.g. "can I see this field", "what am I missing" — since describe_object\'s results ' +
        'already reflect exactly this user\'s field-level security, and a question about "my" ' +
        "access is otherwise unanswerable without knowing who that is. To look up this user's " +
        'record Id, profile, or permission set assignments, run a follow-up SOQL query filtered ' +
        "on this username (e.g. SELECT Id, ProfileId FROM User WHERE Username = '...').",
      inputSchema: { type: 'object', properties: {} },
    },
    run(_input, append) {
      const org = connectionManager.getCurrentOrg();
      append('\n\n[get_current_user]\n');
      if (!org?.username) {
        append('→ error: not connected\n\n');
        return 'Error: no org is currently connected.';
      }
      append(`→ ${org.username}\n\n`);
      return JSON.stringify({
        username: org.username,
        orgId: org.orgId,
        instanceUrl: org.instanceUrl,
      });
    },
  };
}

/** `describe_object` — cached field metadata, so the model never guesses API names. */
export function createDescribeObjectTool(describeService: DescribeService): ToolHandler {
  return {
    spec: {
      name: 'describe_object',
      description:
        'Get the list of available fields for a Salesforce object, AS VISIBLE TO THE ' +
        "CURRENTLY CONNECTED USER — results are filtered by that user's field-level " +
        'security (call get_current_user to find out who that is). A field missing here means ' +
        'this specific user cannot read it, not that it does not exist on the object. Call this ' +
        'before writing any SOQL query to confirm which fields exist — never invent or guess ' +
        'field API names.',
      inputSchema: {
        type: 'object',
        properties: {
          objectName: {
            type: 'string',
            description:
              'The API name of the Salesforce object, e.g. "Account", "Opportunity", "My_Object__c".',
          },
        },
        required: ['objectName'],
      },
    },
    async run(input, append) {
      const name = stringArg(input, 'objectName');
      if (!name) return 'Error: no object name provided.';
      append(`\n\n[describe_object] ${name}\n`);
      try {
        const describe = await describeService.describeSObject(name);
        const fields = describe.fields.map((f) => {
          const proj: { name: string; label: string; type: string; referenceTo?: string[] } = {
            name: f.name,
            label: f.label,
            type: f.type,
          };
          if (f.referenceTo.length) proj.referenceTo = f.referenceTo;
          return proj;
        });
        append(`→ ${fields.length} field(s)\n\n`);
        return JSON.stringify({ objectName: describe.name, fields }, null, 2);
      } catch (err) {
        const msg = (err as Error).message;
        append(`→ error: ${msg}\n\n`);
        return `Error describing object: ${msg}`;
      }
    },
  };
}

/** `run_soql` — read-only follow-up query. Non-SELECT payloads are rejected before execution. */
export function createRunSoqlTool(connectionManager: ConnectionManager): ToolHandler {
  return {
    spec: {
      name: 'run_soql',
      description:
        'Run a SOQL query against the connected Salesforce org and get the matching ' +
        'records back as JSON. Use this only when you need additional data to complete the ' +
        'analysis. Only SELECT/SOQL queries are supported — no data can be modified.\n\n' +
        'Set `useToolingApi: true` for metadata/tooling objects, which the default Standard ' +
        'API cannot query: ApexClass, ApexTrigger, ApexPage, ApexLog, TraceFlag, DebugLevel, ' +
        'Flow, FlowDefinition, ValidationRule, EntityDefinition, and FieldDefinition. ' +
        'FieldDefinition in particular is NOT filtered by field-level security, unlike ' +
        'describe_object — so if a field a user expects seems to be missing, query ' +
        'FieldDefinition (e.g. SELECT QualifiedApiName, Label, DataType FROM FieldDefinition ' +
        "WHERE EntityDefinition.QualifiedApiName = 'Account') to tell whether it genuinely " +
        'does not exist or merely is hidden by permissions. Everyday business data — Account, ' +
        'Contact, custom objects, User, FieldPermissions, PermissionSet, ' +
        'PermissionSetAssignment — uses the default Standard API; leave useToolingApi unset ' +
        'for those.',
      inputSchema: {
        type: 'object',
        properties: {
          soql: {
            type: 'string',
            description: 'A SOQL SELECT query, e.g. "SELECT Id, Name FROM Account LIMIT 10".',
          },
          useToolingApi: {
            type: 'boolean',
            description:
              'Set true to run the query against the Tooling API instead of the Standard API ' +
              '— required for metadata/tooling-only objects (see the tool description).',
          },
        },
        required: ['soql'],
      },
    },
    async run(input, append) {
      const query = stringArg(input, 'soql');
      if (!query) return 'Error: no SOQL query provided.';
      // Defense in depth: query/toolingQuery only run SOQL, but reject anything
      // that does not look like a SELECT so the model cannot be coaxed into a
      // non-query payload.
      if (!/^select\b/i.test(query)) {
        return 'Error: only SELECT/SOQL queries are allowed.';
      }
      const useToolingApi = boolArg(input, 'useToolingApi');
      append(`\n\n[run_soql]${useToolingApi ? ' (tooling)' : ''} ${query}\n`);
      try {
        const result = useToolingApi
          ? await connectionManager.toolingQuery(query)
          : await connectionManager.query(query);
        append(`→ ${result.records.length} record(s)\n\n`);
        return recordsToJson(result.records);
      } catch (err) {
        const msg = (err as Error).message;
        append(`→ error: ${msg}\n\n`);
        return `Error running query: ${msg}`;
      }
    },
  };
}

// Org-facing tools offered to the model: schema lookup and read-only SOQL.
// Both are host-executed — the model can only propose a call.
import type { ConnectionManager } from '../../../salesforce/connection';
import type { DescribeService } from '../../describe/DescribeService';
import { stripRecordAttributes } from '../../../utils/salesforce';
import { stringArg, type ToolHandler } from './ToolHandler';

export function recordsToJson(records: unknown[]): string {
  return JSON.stringify(stripRecordAttributes(records), null, 2);
}

/** `describe_object` — cached field metadata, so the model never guesses API names. */
export function createDescribeObjectTool(describeService: DescribeService): ToolHandler {
  return {
    spec: {
      name: 'describe_object',
      description:
        'Get the list of available fields for a Salesforce object. Call this before writing ' +
        'any SOQL query to confirm which fields exist — never invent or guess field API names.',
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
        'analysis. Only SELECT/SOQL queries are supported — no data can be modified.',
      inputSchema: {
        type: 'object',
        properties: {
          soql: {
            type: 'string',
            description: 'A SOQL SELECT query, e.g. "SELECT Id, Name FROM Account LIMIT 10".',
          },
        },
        required: ['soql'],
      },
    },
    async run(input, append) {
      const query = stringArg(input, 'soql');
      if (!query) return 'Error: no SOQL query provided.';
      // Defense in depth: ConnectionManager.query only runs SOQL, but reject
      // anything that does not look like a SELECT so the model cannot be coaxed
      // into a non-query payload.
      if (!/^select\b/i.test(query)) {
        return 'Error: only SELECT/SOQL queries are allowed.';
      }
      append(`\n\n[run_soql] ${query}\n`);
      try {
        const result = await connectionManager.query(query);
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

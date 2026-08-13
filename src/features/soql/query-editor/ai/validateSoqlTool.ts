// `validate_soql` — the tool that makes "the assistant proves the query works"
// true rather than merely requested. The model could in principle do this with
// run_soql alone, but two things are only available host-side: the probe cap is
// applied by us instead of asked for, and a failure comes back with the same
// SoqlDiagnosticsService findings the manual query path renders (FLS-vs-typo,
// "did you mean", the permission sets that would grant access) instead of a
// bare Salesforce message. That is what lets the model repair on its own.
import type { QueryService } from '../QueryService';
import type { SoqlDiagnostic, SoqlDiagnosticsService } from '../SoqlDiagnosticsService';
import { boolArg, stringArg, type ToolHandler } from '../../../../services/ai/tools/ToolHandler';
import { stripRecordAttributes } from '../../../../utils/salesforce';

/** Keep the echoed sample row small — it is context for the model, not a result set. */
const MAX_SAMPLE_FIELDS = 40;

export interface ValidateSoqlToolOptions {
  queryService: QueryService;
  diagnostics: SoqlDiagnosticsService;
  /** ToolHandler.run takes no signal, so the route's one reaches us by closure. */
  getSignal: () => AbortSignal | undefined;
  /** Called only on a successful probe, so the caller can stamp the proposal as verified. */
  onValidated?: (soql: string, useToolingApi: boolean) => void;
}

/**
 * Cap the probe at a single row. Anchored at the end of the statement, which is
 * where SOQL's own LIMIT belongs: a sub-query's `LIMIT 5` is never last, so it
 * correctly falls through to appending an outer LIMIT. The one miss is a string
 * literal that happens to end in `limit 5`, which costs an uncapped probe and
 * nothing else.
 */
export function capProbe(soql: string): string {
  const trimmed = soql.trim().replace(/;+$/, '').trim();
  return /\blimit\s+\d+\s*$/i.test(trimmed) ? trimmed : `${trimmed} LIMIT 1`;
}

export function createValidateSoqlTool(options: ValidateSoqlToolOptions): ToolHandler {
  const { queryService, diagnostics, getSignal, onValidated } = options;

  return {
    spec: {
      name: 'validate_soql',
      description:
        'Run a candidate SOQL query against the connected org to prove it works, capped at one ' +
        'row. ALWAYS call this before proposing a query to the user — never propose one that ' +
        'has not come back ok.\n\n' +
        'On success you get back the field names the query actually returned and a sample row: ' +
        'check those against what the user asked for, not just that the query parsed. A result ' +
        'of zero rows means the query is valid but matched nothing — usually a filter that is ' +
        'too narrow or simply wrong.\n\n' +
        'On failure you get the verbatim Salesforce error plus diagnostics that explain it — ' +
        'including whether a missing field genuinely does not exist or merely is hidden from ' +
        'this user by field-level security, and which permission set would grant it. Read them ' +
        'and repair the query, then validate again.\n\n' +
        'Set `useToolingApi: true` for metadata objects the Standard API cannot query: ' +
        'ApexClass, ApexTrigger, ApexPage, ApexLog, TraceFlag, DebugLevel, Flow, ' +
        'FlowDefinition, ValidationRule, EntityDefinition, FieldDefinition.',
      inputSchema: {
        type: 'object',
        properties: {
          soql: {
            type: 'string',
            description:
              'The candidate SOQL SELECT query to verify. A LIMIT is added automatically if ' +
              'you do not supply one.',
          },
          useToolingApi: {
            type: 'boolean',
            description:
              'Set true to validate against the Tooling API instead of the Standard API — ' +
              'required for metadata-only objects (see the tool description).',
          },
        },
        required: ['soql'],
      },
    },

    async run(input, append) {
      const soql = stringArg(input, 'soql');
      if (!soql) return 'Error: no SOQL query provided.';
      // Defense in depth: runQuery only runs SOQL, but reject anything that
      // does not look like a SELECT so the tool cannot be coaxed into a
      // non-query payload. Mirrors createRunSoqlTool's guard.
      if (!/^select\b/i.test(soql)) {
        return 'Error: only SELECT/SOQL queries can be validated.';
      }

      const useToolingApi = boolArg(input, 'useToolingApi');
      const probe = capProbe(soql);
      append(`\n\n[validate_soql]${useToolingApi ? ' (tooling)' : ''} ${probe}\n`);

      try {
        const result = await queryService.runQuery(probe, useToolingApi, getSignal());
        const [sampleRow] = stripRecordAttributes(result.records) as Record<string, unknown>[];
        const returnedFields = sampleRow ? Object.keys(sampleRow).slice(0, MAX_SAMPLE_FIELDS) : [];

        append(`→ ok, ${result.records.length} row(s)\n\n`);
        onValidated?.(soql, useToolingApi);

        return JSON.stringify(
          {
            ok: true,
            useToolingApi,
            rowCount: result.records.length,
            returnedFields,
            sampleRow: sampleRow ?? null,
            ...(result.records.length === 0
              ? {
                  warning:
                    'The query is valid but matched no records. Check the filters express what ' +
                    'the user actually asked for before proposing it.',
                }
              : {}),
          },
          null,
          2,
        );
      } catch (err) {
        const message = (err as Error).message;
        // A cancel must propagate, not be reported to the model as a query
        // failure it should try to repair.
        if (message === 'Operation cancelled') throw err;

        append(`→ failed: ${message}\n\n`);
        // diagnose() never throws and never alters the SF message — worst case
        // it returns [] and the model sees exactly what it would have anyway.
        const findings: SoqlDiagnostic[] = await diagnostics.diagnose(soql, message);
        return JSON.stringify({ ok: false, error: message, diagnostics: findings }, null, 2);
      }
    },
  };
}

import type { DescribeService } from '../../../services/describe/DescribeService';
import type { FieldAccessService } from '../../../services/permissions/FieldAccessService';
import { describeRestFailure } from '../../../services/rest/describeRestFailure';
import type { RestCallResult, RestCallService } from '../../../services/rest/RestCallService';
import type { RecordDetailField, RecordDetailData } from '../../../shared/protocol';
import { throwIfAborted } from '../../../utils/abort';
import { stripRecordAttributes } from '../../../utils/salesforce';
import { buildAccessNotes, hiddenFieldsOf, isFlsReadOnly } from './fieldAccess';
import { normalizeRecordId, resolveObjectByKeyPrefix } from './recordId';

/** An sObject API name ends up in a URL path — refused rather than escaped. */
const OBJECT_NAME = /^[A-Za-z0-9_]+$/;

/**
 * Loads one record with every field the running user can read, and saves edits
 * to it. vscode-free.
 *
 * Both directions go through `RestCallService`, not jsforce: that is the path
 * with the 401 session-refresh replay, and it hands back status + body, so a
 * failed PATCH can surface Salesforce's own message verbatim.
 *
 * It also reports where field-level security, rather than the field's own
 * nature, is what stops the user — read-only fields and fully hidden ones, each
 * with the permission sets that would lift it. That part is best-effort: it
 * needs "View Setup and Configuration", and without it the record still loads,
 * just with fewer notes (see `fieldAccessOf`).
 */
export class RecordDetailService {
  constructor(
    private readonly describeService: DescribeService,
    private readonly rest: RestCallService,
    private readonly fieldAccess: FieldAccessService,
    private readonly apiVersion: () => string,
  ) {}

  async load(rawId: string, signal?: AbortSignal): Promise<RecordDetailData> {
    const id = normalizeRecordId(rawId);
    const sobject = await this.resolveObject(id);
    throwIfAborted(signal);
    // Fresh, never cached: `updateable` is the edit gate and must reflect the
    // user's field permissions as of NOW — the same reason SoqlDiagnosticsService
    // never trusts the cache. It also sidesteps disk entries written before the
    // projection carried `updateable` at all.
    const describe = await this.describeService.describeSObjectFresh(sobject.name);
    throwIfAborted(signal);
    // Independent of each other — the access lookups never fail the load.
    const [values, access] = await Promise.all([
      this.fetchValues(sobject.name, id, signal),
      this.fieldAccessOf(sobject.name, describe.fields),
    ]);
    throwIfAborted(signal);
    return {
      objectName: sobject.name,
      objectLabel: sobject.label,
      id,
      fields: describe.fields,
      values,
      ...access,
    };
  }

  /**
   * Read-only-by-FLS fields come from the describe alone; hidden ones need the
   * full field list (FieldDefinition). The grant lookups then run as at most two
   * batched queries — Edit for the first group, Read for the second.
   */
  private async fieldAccessOf(
    objectName: string,
    fields: RecordDetailField[],
  ): Promise<Pick<RecordDetailData, 'access' | 'hiddenFields'>> {
    const readOnly = fields.filter(isFlsReadOnly).map((f) => f.name);
    const hiddenFields = hiddenFieldsOf(
      await this.fieldAccess.fieldDefinitions(objectName),
      fields,
    );
    const hidden = hiddenFields.map((f) => f.name);
    const [editGrants, readGrants] = await Promise.all([
      readOnly.length ? this.fieldAccess.grants(objectName, readOnly, 'edit') : new Map(),
      hidden.length ? this.fieldAccess.grants(objectName, hidden, 'read') : new Map(),
    ]);
    return { access: buildAccessNotes(readOnly, hidden, editGrants, readGrants), hiddenFields };
  }

  /** PATCH only `changes`, then re-read so the UI shows what Salesforce stored. */
  async save(
    objectName: string,
    rawId: string,
    changes: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<RecordDetailData> {
    const id = normalizeRecordId(rawId);
    if (Object.keys(changes).length === 0) throw new Error('Nothing to save.');
    const result = await this.rest.send(
      'PATCH',
      this.recordPath(objectName, id),
      JSON.stringify(changes),
      [],
      signal,
    );
    assertOk(result);
    return this.load(id, signal);
  }

  /**
   * The cached global describe first; on a miss, once more fresh — an object
   * deployed (or permission granted) since the cache was written is otherwise
   * reported as unknown for up to two weeks.
   */
  private async resolveObject(id: string) {
    const cached = await this.describeService.describeGlobal();
    try {
      return resolveObjectByKeyPrefix(cached.sobjects, id);
    } catch {
      const fresh = await this.describeService.describeGlobalFresh();
      return resolveObjectByKeyPrefix(fresh.sobjects, id);
    }
  }

  private async fetchValues(
    objectName: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const result = await this.rest.send('GET', this.recordPath(objectName, id), '', [], signal);
    assertOk(result);
    const body = result.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('Salesforce returned an unexpected response for this record.');
    }
    return stripRecordAttributes(body as Record<string, unknown>);
  }

  private recordPath(objectName: string, id: string): string {
    if (!OBJECT_NAME.test(objectName)) throw new Error(`Invalid object name "${objectName}".`);
    return `/services/data/v${this.apiVersion()}/sobjects/${objectName}/${id}`;
  }
}

function assertOk(result: RestCallResult): void {
  if (result.status < 200 || result.status >= 300) throw new Error(describeRestFailure(result));
}

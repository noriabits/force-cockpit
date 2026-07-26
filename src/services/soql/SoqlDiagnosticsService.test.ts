import { describe, expect, it, vi } from 'vitest';
import { SoqlDiagnosticsService } from './SoqlDiagnosticsService';
import { DescribeService } from '../DescribeService';
import type { ConnectionManager } from '../../salesforce/connection';

const FLS_ERROR =
  "ERROR at Row:1:Column:38\nNo such column 'AssetReferenceId__c' on entity 'QuoteLineItem'. " +
  "If you are attempting to use a custom field, be sure to append the '__c'.";

/** jsforce-shaped field, projected down by DescribeService. */
function field(name: string, extra: Record<string, unknown> = {}) {
  return { name, label: name, type: 'string', referenceTo: [], picklistValues: [], ...extra };
}

function makeMock(overrides: Record<string, unknown> = {}): ConnectionManager {
  return {
    getCurrentOrg: () => ({ orgId: '00Dxx' }),
    describeSObject: vi.fn().mockResolvedValue({ name: 'QuoteLineItem', fields: [] }),
    describeGlobal: vi.fn().mockResolvedValue({ sobjects: [] }),
    toolingQuery: vi.fn().mockResolvedValue({ records: [] }),
    ...overrides,
  } as unknown as ConnectionManager;
}

/** Service under test wired to a memory-only DescribeService (no disk cache). */
function makeService(cm: ConnectionManager) {
  return new SoqlDiagnosticsService(cm, new DescribeService(cm));
}

describe('SoqlDiagnosticsService', () => {
  describe('unknown field', () => {
    it('reports FLS when the field is missing from describe but present in FieldDefinition', async () => {
      const cm = makeMock({
        describeSObject: vi.fn().mockResolvedValue({
          name: 'QuoteLineItem',
          fields: [field('Id'), field('QuoteId')],
        }),
        toolingQuery: vi.fn().mockResolvedValue({
          records: [
            {
              QualifiedApiName: 'AssetReferenceId__c',
              Label: 'Asset Reference Id',
              DataType: 'Text(255)',
            },
          ],
        }),
      });

      const [diagnostic, ...rest] = await makeService(cm).diagnose('SELECT ...', FLS_ERROR);

      expect(rest).toHaveLength(0);
      expect(diagnostic.severity).toBe('warning');
      expect(diagnostic.title).toContain('field-level security');
      expect(diagnostic.detail).toContain('Asset Reference Id');
      expect(diagnostic.detail).toContain('Text(255)');
      expect(diagnostic.suggestions).toBeUndefined();
    });

    it('queries FieldDefinition scoped to the entity', async () => {
      const toolingQuery = vi.fn().mockResolvedValue({ records: [] });
      await makeService(makeMock({ toolingQuery })).diagnose('SELECT ...', FLS_ERROR);

      expect(toolingQuery).toHaveBeenCalledTimes(1);
      const soql = toolingQuery.mock.calls[0][0] as string;
      expect(soql).toContain('FROM FieldDefinition');
      expect(soql).toContain("EntityDefinition.QualifiedApiName = 'QuoteLineItem'");
    });

    it('caches the FieldDefinition result per org and entity', async () => {
      const toolingQuery = vi.fn().mockResolvedValue({
        records: [{ QualifiedApiName: 'Other__c', Label: 'Other', DataType: 'Text' }],
      });
      const service = makeService(makeMock({ toolingQuery }));

      await service.diagnose('SELECT ...', FLS_ERROR);
      await service.diagnose('SELECT ...', FLS_ERROR);

      expect(toolingQuery).toHaveBeenCalledTimes(1);
    });

    it('suggests close names when the field genuinely does not exist', async () => {
      const cm = makeMock({
        describeSObject: vi
          .fn()
          .mockResolvedValue({ name: 'Account', fields: [field('Id'), field('Name')] }),
        toolingQuery: vi.fn().mockResolvedValue({
          records: [
            { QualifiedApiName: 'Id', Label: 'Id', DataType: 'id' },
            { QualifiedApiName: 'Name', Label: 'Name', DataType: 'Text' },
          ],
        }),
      });

      const [diagnostic] = await makeService(cm).diagnose(
        'SELECT Nmae FROM Account',
        "No such column 'Nmae' on entity 'Account'.",
      );

      expect(diagnostic.severity).toBe('info');
      expect(diagnostic.suggestions).toEqual(['Name']);
      expect(diagnostic.detail).toContain('including ones hidden from you');
    });

    it('degrades to visible fields when FieldDefinition is not queryable', async () => {
      const cm = makeMock({
        describeSObject: vi
          .fn()
          .mockResolvedValue({ name: 'Account', fields: [field('Id'), field('Name')] }),
        toolingQuery: vi.fn().mockRejectedValue(new Error('INSUFFICIENT_ACCESS')),
      });

      const [diagnostic] = await makeService(cm).diagnose(
        'SELECT Nmae FROM Account',
        "No such column 'Nmae' on entity 'Account'.",
      );

      expect(diagnostic.severity).toBe('info');
      expect(diagnostic.suggestions).toEqual(['Name']);
      expect(diagnostic.detail).toContain('View Setup and Configuration');
    });

    it('flags a contextual failure when the field IS visible', async () => {
      const cm = makeMock({
        describeSObject: vi
          .fn()
          .mockResolvedValue({ name: 'QuoteLineItem', fields: [field('AssetReferenceId__c')] }),
      });

      const [diagnostic] = await makeService(cm).diagnose('SELECT ...', FLS_ERROR);

      expect(diagnostic.severity).toBe('info');
      expect(diagnostic.title).toContain('readable by your user');
      expect(cm.toolingQuery).not.toHaveBeenCalled();
    });

    it('never interpolates a non-identifier entity name into SOQL', async () => {
      const toolingQuery = vi.fn();
      // The entity name is interpolated into a SOQL string literal, so anything
      // that is not a bare API name is refused rather than escaped.
      await makeService(makeMock({ toolingQuery })).diagnose(
        'SELECT ...',
        "No such column 'Foo' on entity 'Account WHERE Id != null'.",
      );

      expect(toolingQuery).not.toHaveBeenCalled();
    });
  });

  describe('unknown relationship', () => {
    it('suggests relationship names from the FROM object', async () => {
      const cm = makeMock({
        describeSObject: vi.fn().mockResolvedValue({
          name: 'Contact',
          fields: [
            field('AccountId', { relationshipName: 'Account' }),
            field('OwnerId', { relationshipName: 'Owner' }),
            field('Id', { relationshipName: null }),
          ],
        }),
      });

      const [diagnostic] = await makeService(cm).diagnose(
        'SELECT Accont.Name FROM Contact',
        "Didn't understand relationship 'Accont' in field path.",
      );

      expect(diagnostic.title).toContain('not a relationship on Contact');
      expect(diagnostic.suggestions).toEqual(['Account']);
    });

    it('returns nothing when the query has no FROM clause to resolve against', async () => {
      const diagnostics = await makeService(makeMock()).diagnose(
        'SELECT Accont.Name',
        "Didn't understand relationship 'Accont' in field path.",
      );
      expect(diagnostics).toEqual([]);
    });
  });

  describe('unknown object', () => {
    it('reports missing object access when EntityDefinition knows the object', async () => {
      const cm = makeMock({
        describeGlobal: vi.fn().mockResolvedValue({ sobjects: [{ name: 'Account' }] }),
        toolingQuery: vi.fn().mockResolvedValue({ records: [{ QualifiedApiName: 'Secret__c' }] }),
      });

      const [diagnostic] = await makeService(cm).diagnose(
        'SELECT Id FROM Secret__c',
        "sObject type 'Secret__c' is not supported.",
      );

      expect(diagnostic.severity).toBe('warning');
      expect(diagnostic.title).toContain('no access to it');
    });

    it('suggests a close object name when it does not exist at all', async () => {
      const cm = makeMock({
        describeGlobal: vi
          .fn()
          .mockResolvedValue({ sobjects: [{ name: 'Account' }, { name: 'Contact' }] }),
      });

      const [diagnostic] = await makeService(cm).diagnose(
        'SELECT Id FROM Acount',
        "sObject type 'Acount' is not supported.",
      );

      expect(diagnostic.severity).toBe('info');
      expect(diagnostic.suggestions).toEqual(['Account']);
    });
  });

  it('returns no diagnostics for an error it cannot interpret', async () => {
    const diagnostics = await makeService(makeMock()).diagnose(
      'SELECT FROM',
      'MALFORMED_QUERY: unexpected token: FROM',
    );
    expect(diagnostics).toEqual([]);
  });

  it('never throws, even when every lookup fails', async () => {
    const cm = makeMock({
      describeSObject: vi.fn().mockRejectedValue(new Error('Not connected')),
      describeGlobal: vi.fn().mockRejectedValue(new Error('Not connected')),
      toolingQuery: vi.fn().mockRejectedValue(new Error('Not connected')),
      getCurrentOrg: () => null,
    });

    await expect(makeService(cm).diagnose('SELECT ...', FLS_ERROR)).resolves.toEqual([
      expect.objectContaining({ severity: 'info' }),
    ]);
  });
});

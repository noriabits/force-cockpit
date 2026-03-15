import { describe, expect, it, vi } from 'vitest';
import { ReactivateOmniscriptService } from './ReactivateOmniscriptService';
import type { ConnectionManager } from '../../../salesforce/connection';

function makeMock(
  overrides: {
    query?: ReturnType<typeof vi.fn>;
    executeAnonymous?: ReturnType<typeof vi.fn>;
  } = {},
): ConnectionManager {
  return {
    query: overrides.query ?? vi.fn(),
    executeAnonymous: overrides.executeAnonymous ?? vi.fn(),
  } as unknown as ConnectionManager;
}

const apexSuccess = () =>
  Promise.resolve({
    compiled: true,
    success: true,
    compileProblem: null,
    exceptionMessage: null,
    exceptionStackTrace: null,
  });

describe('ReactivateOmniscriptService', () => {
  describe('fetchOmniscripts', () => {
    it('maps vlocity namespace field names to short property names', async () => {
      const mockQuery = vi.fn().mockResolvedValue({
        records: [
          {
            Id: 'os001',
            vlocity_cmt__Type__c: 'Order',
            vlocity_cmt__SubType__c: 'Create',
            vlocity_cmt__Language__c: 'English',
          },
        ],
        totalSize: 1,
        done: true,
      });
      const service = new ReactivateOmniscriptService(makeMock({ query: mockQuery }));

      const result = await service.fetchOmniscripts();

      expect(result).toEqual([
        { Id: 'os001', Type: 'Order', SubType: 'Create', Language: 'English' },
      ]);
    });

    it('replaces null field values with the em-dash placeholder', async () => {
      const mockQuery = vi.fn().mockResolvedValue({
        records: [
          {
            Id: 'os002',
            vlocity_cmt__Type__c: null,
            vlocity_cmt__SubType__c: '',
            vlocity_cmt__Language__c: null,
          },
        ],
        totalSize: 1,
        done: true,
      });
      const service = new ReactivateOmniscriptService(makeMock({ query: mockQuery }));

      const [record] = await service.fetchOmniscripts();

      expect(record.Type).toBe('—');
      expect(record.SubType).toBe('—');
      expect(record.Language).toBe('—');
    });

    it('returns an empty array when the query result has no records', async () => {
      const mockQuery = vi.fn().mockResolvedValue({ records: [], totalSize: 0, done: true });
      const service = new ReactivateOmniscriptService(makeMock({ query: mockQuery }));

      const result = await service.fetchOmniscripts();

      expect(result).toEqual([]);
    });

    it('handles a missing records property gracefully', async () => {
      const mockQuery = vi.fn().mockResolvedValue({ totalSize: 0, done: true });
      const service = new ReactivateOmniscriptService(makeMock({ query: mockQuery }));

      const result = await service.fetchOmniscripts();

      expect(result).toEqual([]);
    });
  });

  describe('reactivate', () => {
    it('returns a success message on successful Apex execution', async () => {
      const service = new ReactivateOmniscriptService(
        makeMock({ executeAnonymous: vi.fn().mockImplementation(apexSuccess) }),
      );

      const result = await service.reactivate('os001');

      expect(result.message).toBe('OmniScript reactivated successfully.');
    });

    it('throws a compilation error when the Apex does not compile', async () => {
      const service = new ReactivateOmniscriptService(
        makeMock({
          executeAnonymous: vi.fn().mockResolvedValue({
            compiled: false,
            success: false,
            compileProblem: 'Unknown type: vlocity_cmt',
            exceptionMessage: null,
            exceptionStackTrace: null,
          }),
        }),
      );

      await expect(service.reactivate('os001')).rejects.toThrow(
        'Apex compilation error: Unknown type: vlocity_cmt',
      );
    });

    it('throws an execution error when Apex fails at runtime', async () => {
      const service = new ReactivateOmniscriptService(
        makeMock({
          executeAnonymous: vi.fn().mockResolvedValue({
            compiled: true,
            success: false,
            compileProblem: null,
            exceptionMessage: 'NullPointerException',
            exceptionStackTrace: null,
          }),
        }),
      );

      await expect(service.reactivate('os001')).rejects.toThrow(
        'Apex execution error: NullPointerException',
      );
    });
  });
});

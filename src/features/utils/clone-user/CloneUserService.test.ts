import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CloneUserService } from './CloneUserService';
import type { ConnectionManager } from '../../../salesforce/connection';

// Minimal ConnectionManager mock — only the methods CloneUserService actually calls
function makeMock(
  overrides: {
    query?: ReturnType<typeof vi.fn>;
    executeAnonymous?: ReturnType<typeof vi.fn>;
    getSandboxName?: ReturnType<typeof vi.fn>;
  } = {},
): ConnectionManager {
  return {
    query: overrides.query ?? vi.fn(),
    executeAnonymous: overrides.executeAnonymous ?? vi.fn(),
    getSandboxName: overrides.getSandboxName ?? vi.fn().mockReturnValue(null),
  } as unknown as ConnectionManager;
}

// Shorthand for a successful executeAnonymous response
const apexSuccess = () =>
  Promise.resolve({
    compiled: true,
    success: true,
    compileProblem: null,
    exceptionMessage: null,
    exceptionStackTrace: null,
  });

const BASE_PARAMS = {
  sourceUserId: 'usr001',
  firstName: 'Alice',
  lastName: 'Wonder',
  email: 'alice@example.com',
};

describe('CloneUserService', () => {
  describe('searchUsers', () => {
    it('maps Salesforce records to UserSearchResult objects', async () => {
      const mockQuery = vi.fn().mockResolvedValue({
        records: [{ Id: '001', Name: 'John Smith', Email: 'j@ex.com', Profile: { Name: 'Admin' } }],
        totalSize: 1,
        done: true,
      });
      const service = new CloneUserService(makeMock({ query: mockQuery }));

      const result = await service.searchUsers('John');

      expect(result).toEqual([
        { Id: '001', Name: 'John Smith', Email: 'j@ex.com', ProfileName: 'Admin' },
      ]);
    });

    it('escapes single quotes in the search term before building SOQL', async () => {
      const mockQuery = vi.fn().mockResolvedValue({ records: [], totalSize: 0, done: true });
      const service = new CloneUserService(makeMock({ query: mockQuery }));

      await service.searchUsers("O'Brien");

      const soql: string = mockQuery.mock.calls[0][0];
      expect(soql).toContain("O''Brien");
    });

    it('returns an empty array when the query has no records', async () => {
      const mockQuery = vi.fn().mockResolvedValue({ records: [], totalSize: 0, done: true });
      const service = new CloneUserService(makeMock({ query: mockQuery }));

      const result = await service.searchUsers('nobody');

      expect(result).toEqual([]);
    });

    it('uses an em-dash placeholder when Profile name is absent', async () => {
      const mockQuery = vi.fn().mockResolvedValue({
        records: [{ Id: '002', Name: 'Jane', Email: 'j@ex.com', Profile: null }],
        totalSize: 1,
        done: true,
      });
      const service = new CloneUserService(makeMock({ query: mockQuery }));

      const [user] = await service.searchUsers('Jane');

      expect(user.ProfileName).toBe('—');
    });
  });

  describe('cloneUser', () => {
    it('generates a plain production username when getSandboxName returns null', async () => {
      const service = new CloneUserService(
        makeMock({
          executeAnonymous: vi.fn().mockImplementation(apexSuccess),
          getSandboxName: vi.fn().mockReturnValue(null),
        }),
      );

      const result = await service.cloneUser(BASE_PARAMS);

      expect(result.message).toContain('alice@example.com.b2b');
      // Must NOT contain a third segment like .b2b.dev
      expect(result.message).not.toMatch(/\.b2b\.\w/);
    });

    it('appends the sandbox name to the username when running in a sandbox', async () => {
      const service = new CloneUserService(
        makeMock({
          executeAnonymous: vi.fn().mockImplementation(apexSuccess),
          getSandboxName: vi.fn().mockReturnValue('dev'),
        }),
      );

      const result = await service.cloneUser(BASE_PARAMS);

      expect(result.message).toContain('alice@example.com.b2b.dev');
    });

    it('throws with a compilation error message when Apex does not compile', async () => {
      const service = new CloneUserService(
        makeMock({
          executeAnonymous: vi.fn().mockResolvedValue({
            compiled: false,
            success: false,
            compileProblem: 'Unexpected token at line 3',
            exceptionMessage: null,
            exceptionStackTrace: null,
          }),
        }),
      );

      await expect(service.cloneUser(BASE_PARAMS)).rejects.toThrow(
        'Apex compilation error: Unexpected token at line 3',
      );
    });

    it('throws with an execution error message when Apex fails at runtime', async () => {
      const service = new CloneUserService(
        makeMock({
          executeAnonymous: vi.fn().mockResolvedValue({
            compiled: true,
            success: false,
            compileProblem: null,
            exceptionMessage: 'DmlException',
            exceptionStackTrace: 'at AnonymousBlock line 12',
          }),
        }),
      );

      await expect(service.cloneUser(BASE_PARAMS)).rejects.toThrow(
        'Apex execution error: DmlException\nat AnonymousBlock line 12',
      );
    });

    it('falls back to "Unknown error" in the exception message when none is provided', async () => {
      const service = new CloneUserService(
        makeMock({
          executeAnonymous: vi.fn().mockResolvedValue({
            compiled: true,
            success: false,
            compileProblem: null,
            exceptionMessage: null,
            exceptionStackTrace: null,
          }),
        }),
      );

      await expect(service.cloneUser(BASE_PARAMS)).rejects.toThrow(
        'Apex execution error: Unknown error',
      );
    });

    it('returns a success message containing the full name and username', async () => {
      const service = new CloneUserService(
        makeMock({
          executeAnonymous: vi.fn().mockImplementation(apexSuccess),
          getSandboxName: vi.fn().mockReturnValue(null),
        }),
      );

      const result = await service.cloneUser(BASE_PARAMS);

      expect(result.message).toContain('Alice Wonder');
      expect(result.message).toContain('alice@example.com.b2b');
    });
  });

  describe('deriveAlias (private)', () => {
    let service: CloneUserService;
    beforeEach(() => {
      service = new CloneUserService(makeMock());
    });

    it('combines the first letter of the first name with up to 4 chars of the last name', () => {
      // 'Smith' has 5 chars; substring(0, 4) = 'Smit'
      expect((service as any).deriveAlias('John', 'Smith')).toBe('JSmit');
    });

    it('does not pad when the last name is shorter than 4 characters', () => {
      expect((service as any).deriveAlias('Alice', 'Li')).toBe('ALi');
    });

    it('truncates the last name at exactly 4 characters', () => {
      // 'Washington' → substring(0, 4) = 'Wash'
      expect((service as any).deriveAlias('Bob', 'Washington')).toBe('BWash');
    });

    it('uses only the first character of a multi-char first name', () => {
      // 'Smit' has exactly 4 chars — all are kept
      expect((service as any).deriveAlias('Elizabeth', 'Smit')).toBe('ESmit');
    });
  });

  describe('escapeApex (private)', () => {
    let service: CloneUserService;
    beforeEach(() => {
      service = new CloneUserService(makeMock());
    });

    it('escapes single quotes with backslash', () => {
      expect((service as any).escapeApex("O'Brien")).toBe("O\\'Brien");
    });

    it('escapes backslashes before quotes', () => {
      expect((service as any).escapeApex("path\\to\\'file")).toBe("path\\\\to\\\\\\'file");
    });

    it('returns empty string unchanged', () => {
      expect((service as any).escapeApex('')).toBe('');
    });

    it('leaves strings without special chars untouched', () => {
      expect((service as any).escapeApex('hello world')).toBe('hello world');
    });
  });

  describe('buildCloneApex (private)', () => {
    let service: CloneUserService;
    beforeEach(() => {
      service = new CloneUserService(makeMock());
    });

    const baseFields = {
      sourceUserId: 'usr1',
      firstName: 'Alice',
      lastName: 'Wonder',
      email: 'a@ex.com',
      username: 'a@ex.com.b2b',
      alias: 'AWon',
    };

    it('includes the username in the generated Apex', () => {
      const apex: string = (service as any).buildCloneApex(baseFields);
      expect(apex).toContain('a@ex.com.b2b');
    });

    it('includes the alias in the generated Apex', () => {
      const apex: string = (service as any).buildCloneApex(baseFields);
      expect(apex).toContain('AWon');
    });

    it('escapes single quotes in string fields', () => {
      const apex: string = (service as any).buildCloneApex({
        ...baseFields,
        firstName: "D'Arcy",
        lastName: "O'Brien",
      });
      expect(apex).toContain("D\\'Arcy");
      expect(apex).toContain("O\\'Brien");
    });

    it('generates Apex that inserts a User record and assigns permission sets', () => {
      const apex: string = (service as any).buildCloneApex(baseFields);
      expect(apex).toContain('insert newUser');
      expect(apex).toContain('PermissionSetAssignment');
    });
  });
});

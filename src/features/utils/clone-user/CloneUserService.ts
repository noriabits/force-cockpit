import type { ConnectionManager } from '../../../salesforce/connection';
import { assertApexSuccess } from '../../apexUtils';

export interface UserSearchResult {
  Id: string;
  Name: string;
  Email: string;
  ProfileName: string;
}

export interface CloneUserParams {
  sourceUserId: string;
  firstName: string;
  lastName: string;
  email: string;
}

export interface CloneUserResult {
  message: string;
}

export class CloneUserService {
  constructor(private readonly connectionManager: ConnectionManager) {}

  async searchUsers(searchTerm: string): Promise<UserSearchResult[]> {
    // SOQL requires doubling single quotes (not backslash escaping)
    const escaped = searchTerm.replace(/'/g, "''");
    const soql =
      `SELECT Id, Name, Email, Profile.Name FROM User ` +
      `WHERE (Name LIKE '%${escaped}%' OR Email LIKE '%${escaped}%') ` +
      `AND IsActive = true ORDER BY Name LIMIT 20`;

    const result = await this.connectionManager.query<{
      Id: string;
      Name: string;
      Email: string;
      Profile: { Name: string };
    }>(soql);

    return (result.records || []).map((r) => ({
      Id: r.Id,
      Name: r.Name,
      Email: r.Email,
      ProfileName: r.Profile?.Name || '—',
    }));
  }

  async cloneUser(params: CloneUserParams): Promise<CloneUserResult> {
    const sandboxName = this.connectionManager.getSandboxName();
    const username = sandboxName ? `${params.email}.b2b.${sandboxName}` : `${params.email}.b2b`;

    const alias = this.deriveAlias(params.firstName, params.lastName);
    const apex = this.buildCloneApex({
      sourceUserId: params.sourceUserId,
      firstName: params.firstName,
      lastName: params.lastName,
      email: params.email,
      username,
      alias,
    });

    const result = await this.connectionManager.executeAnonymous(apex);
    assertApexSuccess(result);

    return {
      message:
        `User "${params.firstName} ${params.lastName}" created successfully with username: ${username}\n` +
        `Profile, role, and permission sets were cloned from the source user.`,
    };
  }

  private deriveAlias(firstName: string, lastName: string): string {
    const firstLetter = firstName.substring(0, 1);
    const lastInitials = lastName.substring(0, Math.min(4, lastName.length));
    return firstLetter + lastInitials;
  }

  /** Escapes a value for use inside an Apex string literal (backslash-based). */
  private escapeApex(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }

  private buildCloneApex(fields: {
    sourceUserId: string;
    firstName: string;
    lastName: string;
    email: string;
    username: string;
    alias: string;
  }): string {
    const esc = (v: string) => this.escapeApex(v);

    return `
      Id originalUserId = '${esc(fields.sourceUserId)}';
      User originalUser = [SELECT ProfileId, UserRoleId FROM User WHERE Id = :originalUserId LIMIT 1];

      User newUser = new User(
          Alias = '${esc(fields.alias)}',
          Username = '${esc(fields.username)}',
          FirstName = '${esc(fields.firstName)}',
          LastName = '${esc(fields.lastName)}',
          Email = '${esc(fields.email)}',
          UserRoleId = originalUser.UserRoleId,
          ProfileId = originalUser.ProfileId,
          IsActive = true,
          // Locale defaults for the primary user base (NL). Expose as VSCode settings to support other regions.
          LocaleSidKey = 'nl_NL',
          LanguageLocaleKey = 'en_US',
          TimeZoneSidKey = 'Europe/Amsterdam',
          EmailEncodingKey = 'ISO-8859-1',
          UserPermissionsSupportUser = true
      );

      Database.DMLOptions dmo = new Database.DMLOptions();
      dmo.EmailHeader.triggerUserEmail = true;
      dmo.EmailHeader.triggerOtherEmail = true;
      dmo.optAllOrNone = false;
      newUser.setOptions(dmo);
      insert newUser;

      List<PermissionSetAssignment> psas = [
          SELECT PermissionSetId
          FROM PermissionSetAssignment
          WHERE AssigneeId = :originalUserId AND PermissionSet.ProfileId = null
      ];

      List<PermissionSetAssignment> newPSAs = new List<PermissionSetAssignment>();
      for (PermissionSetAssignment psa : psas) {
          newPSAs.add(new PermissionSetAssignment(
              AssigneeId = newUser.Id,
              PermissionSetId = psa.PermissionSetId
          ));
      }
      if (!newPSAs.isEmpty()) {
          insert newPSAs;
      }

      System.debug('NEW_USER_ID:' + newUser.Id);
      System.debug('PERM_SETS_CLONED:' + newPSAs.size());`;
  }
}

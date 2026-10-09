import { describe, expect, it } from 'vitest';
import { DEFAULT_APEX_TAB_BASE, apexBaseName } from './apex-tab-name';

describe('apexBaseName', () => {
  it.each([
    ['System.debug(UserInfo.getUserName());', 'UserInfo'],
    ["Account a = new Account(Name = 'x');\ninsert a;", 'Account'],
    ['List<Contact> cs = [SELECT Id FROM Contact];', 'Contact'],
    ['MyInvoiceService.recalculate();', 'MyInvoiceService'],
    ['for (Integer i = 0; i < 3; i++) { System.debug(i); }', 'i'],
  ])('%s → %s', (code, expected) => {
    expect(apexBaseName(code)).toBe(expected);
  });

  it('ignores comments and string literals', () => {
    expect(apexBaseName("// Order fix\n/* Lead */ System.debug('Case');\nOpportunity o;")).toBe(
      'Opportunity',
    );
  });

  it.each(['', '   ', 'System.debug(1);', '// just a comment'])(
    'falls back to the default base for %j',
    (code) => {
      expect(apexBaseName(code)).toBe(DEFAULT_APEX_TAB_BASE);
    },
  );

  it('caps a very long identifier', () => {
    expect(apexBaseName('A'.repeat(80) + '.run();')).toHaveLength(32);
  });
});

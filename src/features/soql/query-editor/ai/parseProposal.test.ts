import { describe, expect, it } from 'vitest';
import { parseProposal } from './parseProposal';

describe('parseProposal', () => {
  it('extracts a single fenced query', () => {
    const answer = 'Here you go:\n\n```soql\nSELECT Id, Name FROM Account\n```\n';
    expect(parseProposal(answer)).toEqual({
      query: 'SELECT Id, Name FROM Account',
      useToolingApi: false,
    });
  });

  it('keeps the LAST block when the model showed drafts on the way', () => {
    const answer = [
      'First attempt:',
      '```soql',
      'SELECT Id FROM Acount',
      '```',
      'That failed, so:',
      '```soql',
      'SELECT Id FROM Account',
      '```',
    ].join('\n');
    expect(parseProposal(answer)?.query).toBe('SELECT Id FROM Account');
  });

  it('preserves a multi-line query verbatim', () => {
    const answer = "```soql\nSELECT Id\nFROM Account\nWHERE Name = 'Acme'\n```";
    expect(parseProposal(answer)?.query).toBe("SELECT Id\nFROM Account\nWHERE Name = 'Acme'");
  });

  it('returns null for a clarifying reply with no block', () => {
    expect(parseProposal('Did you mean the Account name or the account number?')).toBeNull();
  });

  it('returns null when the block is empty', () => {
    expect(parseProposal('```soql\n\n```')).toBeNull();
  });

  it('reads useToolingApi from the meta block', () => {
    const answer = [
      '```soql',
      'SELECT Id, Name FROM ApexClass',
      '```',
      '```soql-meta',
      '{"useToolingApi": true}',
      '```',
    ].join('\n');
    expect(parseProposal(answer)).toEqual({
      query: 'SELECT Id, Name FROM ApexClass',
      useToolingApi: true,
    });
  });

  it('defaults useToolingApi to false when the meta block is absent', () => {
    expect(parseProposal('```soql\nSELECT Id FROM Account\n```')?.useToolingApi).toBe(false);
  });

  it('ignores a malformed meta block rather than dropping the query', () => {
    const answer = [
      '```soql',
      'SELECT Id FROM Account',
      '```',
      '```soql-meta',
      '{ not json at all',
      '```',
    ].join('\n');
    expect(parseProposal(answer)).toEqual({
      query: 'SELECT Id FROM Account',
      useToolingApi: false,
    });
  });

  it('ignores a meta block whose useToolingApi is not a real boolean', () => {
    const answer =
      '```soql\nSELECT Id FROM Account\n```\n```soql-meta\n{"useToolingApi":"yes"}\n```';
    expect(parseProposal(answer)?.useToolingApi).toBe(false);
  });

  it('handles CRLF line endings', () => {
    expect(parseProposal('```soql\r\nSELECT Id FROM Account\r\n```')?.query).toBe(
      'SELECT Id FROM Account',
    );
  });

  it('is not confused by other fenced languages', () => {
    const answer = '```json\n{"a":1}\n```\n```soql\nSELECT Id FROM Account\n```';
    expect(parseProposal(answer)?.query).toBe('SELECT Id FROM Account');
  });
});

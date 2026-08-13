import { describe, expect, it } from 'vitest';
import { buildRequestMessage, MAX_RESULT_ROWS } from './requestMessage';

describe('buildRequestMessage', () => {
  it('sends the request alone when the editor is empty', () => {
    expect(buildRequestMessage({ question: 'all accounts' })).toBe('## Request\nall accounts');
  });

  it('includes the editor contents as context when there are any', () => {
    const message = buildRequestMessage({
      question: "why doesn't this work?",
      currentQuery: 'SELECT Id, Nmae FROM Account',
    });
    expect(message).toContain('## Current query in the editor');
    expect(message).toContain('SELECT Id, Nmae FROM Account');
    expect(message).toContain("## Request\nwhy doesn't this work?");
    // Context first, so the request reads as being about it.
    expect(message.indexOf('## Current query')).toBeLessThan(message.indexOf('## Request'));
  });

  it('states which API the editor is set to run against', () => {
    expect(
      buildRequestMessage({
        question: 'q',
        currentQuery: 'SELECT Id FROM ApexClass',
        currentUseToolingApi: true,
      }),
    ).toContain('Tooling API');
    expect(
      buildRequestMessage({ question: 'q', currentQuery: 'SELECT Id FROM Account' }),
    ).toContain('Standard API');
  });

  it('skips an untouched new tab rather than sending noise', () => {
    // tabs.js pre-fills every new tab with this.
    expect(buildRequestMessage({ question: 'all accounts', currentQuery: 'SELECT Id FROM ' })).toBe(
      '## Request\nall accounts',
    );
  });

  it('skips a whitespace-only editor', () => {
    expect(buildRequestMessage({ question: 'q', currentQuery: '   \n  ' })).toBe('## Request\nq');
  });

  it('keeps a real query that merely starts like the placeholder', () => {
    const message = buildRequestMessage({ question: 'q', currentQuery: 'SELECT Id FROM Account' });
    expect(message).toContain('## Current query in the editor');
  });

  it('fences the query so the model cannot confuse it with instructions', () => {
    const message = buildRequestMessage({ question: 'q', currentQuery: 'SELECT Id FROM Account' });
    expect(message).toContain('```soql\nSELECT Id FROM Account\n```');
  });
});

describe('buildRequestMessage — last run', () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ Id: `00${i}`, Name: `Acct ${i}` }));

  it('omits the block entirely when nothing has been run', () => {
    expect(buildRequestMessage({ question: 'q', lastRun: null })).toBe('## Request\nq');
  });

  it('includes the returned rows and their columns', () => {
    const message = buildRequestMessage({
      question: 'why is Name blank?',
      lastRun: { records: rows(2), totalSize: 2 },
    });
    expect(message).toContain("## The user's last run returned 2 row(s)");
    expect(message).toContain('Columns: Id, Name');
    expect(message).toContain('"Acct 0"');
    expect(message).toContain('All 2 row(s).');
  });

  it('samples large result sets and says so, keeping the real total', () => {
    const message = buildRequestMessage({
      question: 'q',
      lastRun: { records: rows(50), totalSize: 1873 },
    });
    expect(message).toContain('returned 1873 row(s)');
    expect(message).toContain(`Showing the first ${MAX_RESULT_ROWS} of 1873 row(s)`);
    expect(message).toContain('a sample, not the whole result');
    expect(message).not.toContain('Acct 20');
  });

  it('drops rows further rather than emitting unparseable truncated JSON', () => {
    const fat = Array.from({ length: MAX_RESULT_ROWS }, (_, i) => ({
      Id: `00${i}`,
      Blob__c: 'x'.repeat(2000),
    }));
    const message = buildRequestMessage({
      question: 'q',
      lastRun: { records: fat, totalSize: 10 },
    });
    const json = message.slice(message.indexOf('```json') + 7, message.lastIndexOf('```'));
    expect(() => JSON.parse(json)).not.toThrow();
    expect(JSON.parse(json).length).toBeLessThan(MAX_RESULT_ROWS);
  });

  it('strips jsforce record attributes', () => {
    const message = buildRequestMessage({
      question: 'q',
      lastRun: {
        records: [{ attributes: { type: 'Account', url: '/x' }, Id: '001' }],
        totalSize: 1,
      },
    });
    expect(message).not.toContain('attributes');
    expect(message).toContain('Columns: Id');
  });

  it('calls out a zero-row run explicitly', () => {
    const message = buildRequestMessage({ question: 'q', lastRun: { records: [], totalSize: 0 } });
    expect(message).toContain('returned NO ROWS');
    expect(message).toContain('valid but matched nothing');
  });

  it('reports a failed run with the verbatim Salesforce error', () => {
    const message = buildRequestMessage({
      question: 'why?',
      lastRun: {
        query: 'SELECT Nmae FROM Account',
        error: "No such column 'Nmae' on entity 'Account'.",
      },
    });
    expect(message).toContain("## The user's last run FAILED");
    expect(message).toContain("No such column 'Nmae' on entity 'Account'.");
    expect(message).toContain('SELECT Nmae FROM Account');
  });

  it('names the query that actually ran, which may differ from the editor', () => {
    const message = buildRequestMessage({
      question: 'q',
      currentQuery: 'SELECT Id, Industry FROM Account',
      lastRun: { query: 'SELECT Id FROM Account', records: rows(1), totalSize: 1 },
    });
    expect(message).toContain('SELECT Id, Industry FROM Account'); // editor
    expect(message).toContain('They ran:'); // the older query behind the rows
    expect(message).toContain('SELECT Id FROM Account');
  });

  it('orders the blocks editor → last run → request', () => {
    const message = buildRequestMessage({
      question: 'q',
      currentQuery: 'SELECT Id FROM Account',
      lastRun: { records: rows(1), totalSize: 1 },
    });
    expect(message.indexOf('## Current query')).toBeLessThan(
      message.indexOf("## The user's last run"),
    );
    expect(message.indexOf("## The user's last run")).toBeLessThan(message.indexOf('## Request'));
  });
});

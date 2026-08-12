import { describe, it, expect } from 'vitest';
import { extractOutputMarkers } from './scriptOutputs';

describe('extractOutputMarkers', () => {
  it('returns an empty object for undefined or empty text', () => {
    expect(extractOutputMarkers(undefined)).toEqual({});
    expect(extractOutputMarkers('')).toEqual({});
  });

  it('extracts a single marker', () => {
    expect(extractOutputMarkers('::fc-output accountId=001xx0000000001')).toEqual({
      accountId: '001xx0000000001',
    });
  });

  it('extracts several markers and ignores surrounding log lines', () => {
    const log = [
      'starting up',
      '::fc-output accountId=001xx0000000001',
      'created a quote',
      '::fc-output quoteId=0Q0xx0000000002',
      'done',
    ].join('\n');
    expect(extractOutputMarkers(log)).toEqual({
      accountId: '001xx0000000001',
      quoteId: '0Q0xx0000000002',
    });
  });

  it('keeps "=" inside the value', () => {
    expect(extractOutputMarkers('::fc-output url=https://x.test/?a=1&b=2')).toEqual({
      url: 'https://x.test/?a=1&b=2',
    });
  });

  it('trims surrounding whitespace and tolerates indentation', () => {
    expect(extractOutputMarkers('   ::fc-output  name =  spaced out  ')).toEqual({
      name: 'spaced out',
    });
  });

  it('lets a later marker overwrite an earlier one', () => {
    expect(extractOutputMarkers('::fc-output id=first\n::fc-output id=second')).toEqual({
      id: 'second',
    });
  });

  it('supports an empty value', () => {
    expect(extractOutputMarkers('::fc-output missing=')).toEqual({ missing: '' });
  });

  it('ignores lines that only mention the marker', () => {
    const log = ['print ::fc-output somewhere mid-line', '::fc-output', '::fc-output novalue'].join(
      '\n',
    );
    expect(extractOutputMarkers(log)).toEqual({});
  });

  it('ignores names that are not valid identifiers', () => {
    expect(extractOutputMarkers('::fc-output 9lives=cat\n::fc-output has-dash=x')).toEqual({});
  });
});

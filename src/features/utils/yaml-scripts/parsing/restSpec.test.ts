import { describe, expect, it } from 'vitest';
import { hasRestKey, parseRestSpec, restBody, restBodyFile } from './restSpec';

/** Narrow the result union in a way that fails loudly on the wrong branch. */
function ok(raw: unknown) {
  const result = parseRestSpec(raw);
  if ('error' in result) throw new Error(`expected a valid spec, got: ${result.error}`);
  return result.rest;
}

function err(raw: unknown): string {
  const result = parseRestSpec(raw);
  if (!('error' in result)) throw new Error('expected an error, got a valid spec');
  return result.error;
}

describe('parseRestSpec', () => {
  it('defaults the method to GET', () => {
    expect(ok({ endpoint: '/limits' })).toEqual({ method: 'GET', endpoint: '/limits' });
  });

  it('uppercases the method and trims the endpoint', () => {
    expect(ok({ method: ' patch ', endpoint: '  /x  ' })).toEqual({
      method: 'PATCH',
      endpoint: '/x',
    });
  });

  it('omits headers entirely when none are usable', () => {
    expect(ok({ endpoint: '/x', headers: {} })).not.toHaveProperty('headers');
    // A blank name is skipped rather than written as an empty key.
    expect(ok({ endpoint: '/x', headers: { '  ': 'v' } })).not.toHaveProperty('headers');
  });

  it('coerces unquoted scalar header values to strings and trims names', () => {
    expect(
      ok({ endpoint: '/x', headers: { ' X-Retry ': 3, 'X-On': true, 'X-Nil': null } }),
    ).toEqual({
      method: 'GET',
      endpoint: '/x',
      headers: { 'X-Retry': '3', 'X-On': 'true', 'X-Nil': '' },
    });
  });

  describe('rejections', () => {
    it('rejects a missing, null or non-object block', () => {
      // A bare `rest:` is YAML null — it still declares the type, so the message
      // must name the rest block rather than claim no script field was set.
      for (const raw of [undefined, null, 'GET /x', ['a']]) {
        expect(err(raw)).toContain("'rest' must be an object");
      }
    });

    it('rejects body and body-file set together', () => {
      expect(err({ endpoint: '/x', body: '{}', 'body-file': 'b.json' })).toContain('ambiguous');
    });

    it('rejects a non-string body', () => {
      // `body: {"Name": "Acme"}` without a `|` block is a YAML mapping.
      expect(err({ endpoint: '/x', body: { Name: 'Acme' } })).toContain("'rest.body'");
    });

    it('rejects a missing or blank endpoint', () => {
      expect(err({ method: 'GET' })).toContain("missing required field: 'endpoint'");
      expect(err({ endpoint: '   ' })).toContain("missing required field: 'endpoint'");
    });

    it('rejects an unsupported verb rather than downgrading it to GET', () => {
      expect(err({ method: 'FETCH', endpoint: '/x' })).toContain('FETCH');
      expect(err({ method: 42, endpoint: '/x' })).toContain("'rest.method'");
    });

    it('rejects headers that are not a map of scalars', () => {
      expect(err({ endpoint: '/x', headers: { Accept: ['a'] } })).toContain('headers');
      expect(err({ endpoint: '/x', headers: { Accept: { q: 1 } } })).toContain('headers');
      expect(err({ endpoint: '/x', headers: 'Accept: a' })).toContain('headers');
    });
  });

  // Guard order is pinned because a file with two problems must keep reporting
  // the same one it always has.
  it('reports the body ambiguity before the missing endpoint', () => {
    expect(err({ body: '{}', 'body-file': 'b.json' })).toContain('ambiguous');
  });

  it('reports a missing endpoint before a bad verb', () => {
    expect(err({ method: 'FETCH' })).toContain("missing required field: 'endpoint'");
  });
});

describe('hasRestKey', () => {
  it('is true for a declared key even when the value is null', () => {
    expect(hasRestKey({ rest: null })).toBe(true);
    expect(hasRestKey({ rest: { endpoint: '/x' } })).toBe(true);
  });

  it('is false when the key is absent', () => {
    expect(hasRestKey({ apex: 'x' })).toBe(false);
  });
});

describe('restBodyFile / restBody', () => {
  it('reads a usable body-file path, ignoring blank and non-string ones', () => {
    expect(restBodyFile({ 'body-file': 'b.json' })).toBe('b.json');
    expect(restBodyFile({ 'body-file': '   ' })).toBeUndefined();
    expect(restBodyFile({ 'body-file': 42 })).toBeUndefined();
    expect(restBodyFile(undefined)).toBeUndefined();
  });

  it('falls back to an empty body — a GET or DELETE carries none', () => {
    expect(restBody({ body: '{}' })).toBe('{}');
    expect(restBody({})).toBe('');
    expect(restBody(undefined)).toBe('');
  });
});

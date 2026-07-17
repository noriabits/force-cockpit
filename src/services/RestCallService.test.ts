import { describe, expect, it, vi } from 'vitest';
import { RestCallService } from './RestCallService';
import type { ConnectionManager } from '../salesforce/connection';

function makeMock(requestImpl?: (...args: unknown[]) => unknown): ConnectionManager {
  return {
    request: vi.fn(
      requestImpl ??
        (() => Promise.resolve({ status: 200, statusText: 'OK', headers: {}, body: { ok: true } })),
    ),
  } as unknown as ConnectionManager;
}

describe('RestCallService.send', () => {
  it('normalizes a relative endpoint to a single leading slash', async () => {
    const cm = makeMock();
    await new RestCallService(cm).send('GET', 'services/data/v65.0/limits', '');
    expect(cm.request).toHaveBeenCalledWith(
      expect.objectContaining({ url: '/services/data/v65.0/limits' }),
    );
  });

  it('collapses redundant leading slashes', async () => {
    const cm = makeMock();
    await new RestCallService(cm).send('GET', '///services/data', '');
    expect(cm.request).toHaveBeenCalledWith(expect.objectContaining({ url: '/services/data' }));
  });

  it('leaves an absolute URL untouched', async () => {
    const cm = makeMock();
    await new RestCallService(cm).send('GET', 'https://example.com/x', '');
    expect(cm.request).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://example.com/x' }),
    );
  });

  it('omits the body for GET even when one is supplied', async () => {
    const cm = makeMock();
    await new RestCallService(cm).send('GET', '/x', '{"a":1}');
    const arg = (cm.request as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.body).toBeUndefined();
  });

  it('sends the body for POST and defaults the JSON content type', async () => {
    const cm = makeMock();
    await new RestCallService(cm).send('post', '/x', '{"a":1}');
    expect(cm.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        body: '{"a":1}',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  it('omits an empty/whitespace body for POST', async () => {
    const cm = makeMock();
    await new RestCallService(cm).send('POST', '/x', '   ');
    const arg = (cm.request as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.body).toBeUndefined();
  });

  it('returns the status/headers/body from the connection', async () => {
    const cm = makeMock(() =>
      Promise.resolve({ status: 201, headers: { 'x-foo': 'bar' }, body: { id: '001' } }),
    );
    const res = await new RestCallService(cm).send('GET', '/x', '');
    expect(res).toEqual({ status: 201, headers: { 'x-foo': 'bar' }, body: { id: '001' } });
  });

  it('propagates errors from the connection', async () => {
    const cm = makeMock(() => Promise.reject(new Error('NOT_FOUND: bad path')));
    await expect(new RestCallService(cm).send('GET', '/x', '')).rejects.toThrow(
      'NOT_FOUND: bad path',
    );
  });

  it('merges custom headers alongside the default Content-Type', async () => {
    const cm = makeMock();
    await new RestCallService(cm).send('GET', '/x', '', [{ key: 'X-Custom', value: '1' }]);
    expect(cm.request).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: { 'Content-Type': 'application/json', 'X-Custom': '1' },
      }),
    );
  });

  it('lets a user-supplied header override the default Content-Type case-insensitively', async () => {
    const cm = makeMock();
    await new RestCallService(cm).send('POST', '/x', '<a/>', [
      { key: 'content-type', value: 'application/xml' },
    ]);
    const arg = (cm.request as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.headers).toEqual({ 'content-type': 'application/xml' });
  });

  it('ignores blank-key header rows', async () => {
    const cm = makeMock();
    await new RestCallService(cm).send('GET', '/x', '', [{ key: '  ', value: 'ignored' }]);
    expect(cm.request).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { 'Content-Type': 'application/json' } }),
    );
  });
});

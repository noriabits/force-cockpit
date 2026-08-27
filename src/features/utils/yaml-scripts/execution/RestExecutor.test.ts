import { describe, it, expect, vi } from 'vitest';
import { RestExecutor } from './RestExecutor';
import type { RestCallService, RestCallResult } from '../../../../services/rest/RestCallService';
import type { YamlScript } from '../types';

function makeScript(overrides: Partial<YamlScript> = {}): YamlScript {
  return {
    id: 'cat/call',
    folder: 'cat',
    name: 'Call',
    description: '',
    type: 'rest',
    script: '',
    source: 'user',
    rest: { method: 'GET', endpoint: '/services/data/v65.0/limits' },
    ...overrides,
  };
}

function makeService(result: Partial<RestCallResult> | Error): {
  service: RestCallService;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return {
      status: 200,
      statusText: 'OK',
      headers: {},
      body: undefined,
      ...result,
    } as RestCallResult;
  });
  return { service: { send } as unknown as RestCallService, send };
}

describe('RestExecutor', () => {
  it("sends the script's method, endpoint, body and headers", async () => {
    const { service, send } = makeService({});
    const script = makeScript({
      script: '{"Name":"Acme"}',
      rest: {
        method: 'POST',
        endpoint: '/sobjects/Account',
        headers: { Accept: 'application/json' },
      },
    });

    await new RestExecutor(service).execute(script);

    expect(send).toHaveBeenCalledWith(
      'POST',
      '/sobjects/Account',
      '{"Name":"Acme"}',
      [{ key: 'Accept', value: 'application/json' }],
      undefined,
    );
  });

  it("succeeds on a 2xx and publishes status plus the body's top-level scalars", async () => {
    const { service } = makeService({
      status: 201,
      statusText: 'Created',
      body: { id: '001xx000003DGb2AAG', success: true, errors: [] },
    });

    const result = await new RestExecutor(service).execute(makeScript());

    expect(result.success).toBe(true);
    // `errors` is an array — not something a `then: with:` value can carry.
    expect(result.outputs).toEqual({
      id: '001xx000003DGb2AAG',
      success: 'true',
      status: '201',
    });
  });

  it('lets the HTTP status win over a body field of the same name', async () => {
    const { service } = makeService({ status: 200, body: { status: 'Queued' } });
    const result = await new RestExecutor(service).execute(makeScript());
    expect(result.outputs?.status).toBe('200');
  });

  it('publishes only status for an array body', async () => {
    const { service } = makeService({ status: 200, body: [{ Id: 'a' }, { Id: 'b' }] });
    const result = await new RestExecutor(service).execute(makeScript());
    expect(result.outputs).toEqual({ status: '200' });
  });

  it('publishes only status for a non-JSON body', async () => {
    const { service } = makeService({ status: 200, body: 'plain text' });
    const result = await new RestExecutor(service).execute(makeScript());
    expect(result.outputs).toEqual({ status: '200' });
  });

  // The REST tab renders a non-2xx as a normal result; a script must fail on it
  // so a `then:` chain stops instead of handing a 404 to the next step.
  it('fails on a non-2xx and surfaces the Salesforce error message', async () => {
    const { service } = makeService({
      status: 400,
      statusText: 'Bad Request',
      body: [
        { message: 'Required fields are missing: [Name]', errorCode: 'REQUIRED_FIELD_MISSING' },
      ],
    });

    const result = await new RestExecutor(service).execute(makeScript());

    expect(result.success).toBe(false);
    expect(result.message).toContain('REQUIRED_FIELD_MISSING');
    expect(result.message).toContain('Required fields are missing: [Name]');
  });

  it('falls back to the status line when the body carries no message', async () => {
    const { service } = makeService({ status: 404, statusText: 'Not Found', body: null });
    const result = await new RestExecutor(service).execute(makeScript());
    expect(result.success).toBe(false);
    expect(result.message).toContain('404');
  });

  it('logs the request line, status and pretty-printed body', async () => {
    const { service } = makeService({ status: 200, body: { a: 1 } });
    const result = await new RestExecutor(service).execute(makeScript());
    expect(result.debugLog).toContain('GET /services/data/v65.0/limits');
    expect(result.debugLog).toContain('200 OK');
    expect(result.debugLog).toContain('"a": 1');
  });

  it('notes a refreshed session in the log', async () => {
    const { service } = makeService({ status: 200, sessionRefreshed: true });
    const result = await new RestExecutor(service).execute(makeScript());
    expect(result.debugLog).toContain('session refreshed');
  });

  it('streams the log through onLogChunk', async () => {
    const { service } = makeService({ status: 200, body: { a: 1 } });
    const chunks: string[] = [];
    await new RestExecutor(service).execute(makeScript(), undefined, (c) => chunks.push(c));
    expect(chunks.join('')).toContain('200 OK');
  });

  it('reports a cancelled run when the signal is already aborted', async () => {
    const { service, send } = makeService({});
    const controller = new AbortController();
    controller.abort();

    const result = await new RestExecutor(service).execute(makeScript(), controller.signal);

    expect(result.cancelled).toBe(true);
    expect(result.success).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  // A fetch aborted in flight rejects with an AbortError, NOT the shared
  // 'Operation cancelled' sentinel — nothing between `fetch` and here rewrites it.
  // Faking the sentinel would test a shape the real stack never produces.
  it('reports a cancelled run when the request aborts in flight', async () => {
    const controller = new AbortController();
    const service = {
      send: vi.fn(async () => {
        controller.abort();
        throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
      }),
    } as unknown as RestCallService;

    const result = await new RestExecutor(service).execute(makeScript(), controller.signal);

    expect(result.cancelled).toBe(true);
    expect(result.success).toBe(false);
  });

  it('fails with the error message on a network-level failure', async () => {
    const { service } = makeService(new Error('fetch failed'));
    const result = await new RestExecutor(service).execute(makeScript());
    expect(result.success).toBe(false);
    expect(result.message).toBe('fetch failed');
    expect(result.cancelled).toBeUndefined();
  });

  it('fails cleanly when the script has no rest block', async () => {
    const { service, send } = makeService({});
    const result = await new RestExecutor(service).execute(makeScript({ rest: undefined }));
    expect(result.success).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { ToolingRest } from './ToolingRest';
import type { ConnectionManager } from '../../../../salesforce/connection';

function makeConnectionManager(
  requestImpl: (opts: { method: string; url: string }) => Promise<unknown>,
) {
  return {
    apiVersion: '65.0',
    request: vi.fn(requestImpl),
  } as unknown as ConnectionManager;
}

describe('removeMultiple', () => {
  it('hits the standard API base, never /tooling — the Tooling equivalent 404s on a live org', async () => {
    const cm = makeConnectionManager(async () => ({ status: 200, statusText: 'OK', body: [] }));
    await new ToolingRest(cm).removeMultiple(['id1', 'id2']);

    expect(cm.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'DELETE',
        url: '/services/data/v65.0/composite/sobjects?ids=id1,id2',
      }),
    );
  });

  it('passes through a genuine success', async () => {
    const cm = makeConnectionManager(async () => ({
      status: 200,
      statusText: 'OK',
      body: [{ id: 'id1', success: true, errors: [] }],
    }));
    const result = await new ToolingRest(cm).removeMultiple(['id1']);

    expect(result).toEqual([{ id: 'id1', success: true, errors: [] }]);
  });

  it("treats an already-gone record (INVALID_CROSS_REFERENCE_KEY) as success, mirroring remove()'s 404-is-fine idempotency", async () => {
    const cm = makeConnectionManager(async () => ({
      status: 200,
      statusText: 'OK',
      body: [
        {
          id: 'id1',
          success: false,
          errors: [
            { statusCode: 'INVALID_CROSS_REFERENCE_KEY', message: 'invalid cross reference id' },
          ],
        },
      ],
    }));
    const result = await new ToolingRest(cm).removeMultiple(['id1']);

    expect(result).toEqual([
      {
        id: 'id1',
        success: true,
        errors: [
          { statusCode: 'INVALID_CROSS_REFERENCE_KEY', message: 'invalid cross reference id' },
        ],
      },
    ]);
  });

  it('leaves a genuine per-record failure as a failure', async () => {
    const cm = makeConnectionManager(async () => ({
      status: 200,
      statusText: 'OK',
      body: [{ id: 'id1', success: false, errors: [{ statusCode: 'INSUFFICIENT_ACCESS' }] }],
    }));
    const result = await new ToolingRest(cm).removeMultiple(['id1']);

    expect(result).toEqual([
      { id: 'id1', success: false, errors: [{ statusCode: 'INSUFFICIENT_ACCESS' }] },
    ]);
  });

  it('throws on a batch-level non-2xx', async () => {
    const cm = makeConnectionManager(async () => ({
      status: 400,
      statusText: 'Bad Request',
      body: [{ message: 'exceeded 200 records', errorCode: 'LIMIT_EXCEEDED' }],
    }));

    await expect(new ToolingRest(cm).removeMultiple(['id1'])).rejects.toThrow(
      'LIMIT_EXCEEDED: exceeded 200 records',
    );
  });
});

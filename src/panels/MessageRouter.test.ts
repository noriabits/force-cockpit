import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  showWarningMessage,
  showErrorMessage,
  showTextDocument,
  executeCommand,
  openExternal,
  writeFile,
  workspaceFolders,
} = vi.hoisted(() => ({
  showWarningMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  showTextDocument: vi.fn(),
  executeCommand: vi.fn(),
  openExternal: vi.fn(),
  writeFile: vi.fn(),
  workspaceFolders: { value: undefined as unknown },
}));
vi.mock('vscode', () => ({
  window: { showWarningMessage, showErrorMessage, showTextDocument },
  commands: { executeCommand },
  env: { openExternal },
  workspace: {
    get workspaceFolders() {
      return workspaceFolders.value;
    },
  },
  Uri: {
    parse: (s: string) => ({ toString: () => s, _raw: s }),
    file: (s: string) => ({ fsPath: s, _file: s }),
  },
}));
vi.mock('fs', () => ({ promises: { writeFile } }));

import { MessageRouter } from './MessageRouter';
import type { ConnectionManager } from '../salesforce/connection';
import type { QueryService } from '../services/QueryService';
import type { FeatureModule } from '../features/FeatureModule';
import type { OperationRegistry } from './OperationRegistry';

function makeRouter(
  opts: {
    features?: FeatureModule[];
    runQuery?: ReturnType<typeof vi.fn>;
    getCurrentOrg?: ReturnType<typeof vi.fn>;
    onReady?: ReturnType<typeof vi.fn>;
    operations?: Partial<OperationRegistry>;
  } = {},
) {
  const postMessage = vi.fn();
  const webview = { postMessage } as unknown as import('vscode').Webview;
  const connectionManager = {
    getCurrentOrg: opts.getCurrentOrg ?? vi.fn(() => null),
  } as unknown as ConnectionManager;
  const queryService = {
    runQuery: opts.runQuery ?? vi.fn().mockResolvedValue({ records: [] }),
  } as unknown as QueryService;
  const operations = {
    startWebviewOp: vi.fn(),
    endWebviewOp: vi.fn(),
    cancelTerminalOp: vi.fn(),
    createTerminalAbort: vi.fn(() => new AbortController()),
    endTerminalOp: vi.fn(),
    ...opts.operations,
  } as unknown as OperationRegistry;
  const onReady = opts.onReady ?? vi.fn().mockResolvedValue(undefined);

  const router = new MessageRouter({
    webview,
    connectionManager,
    queryService,
    features: opts.features ?? [],
    operations,
    onReady,
  });
  return { router, postMessage, operations, onReady };
}

beforeEach(() => {
  showWarningMessage.mockReset();
  showErrorMessage.mockReset();
  showTextDocument.mockReset();
  executeCommand.mockReset();
  openExternal.mockReset();
  writeFile.mockReset();
  workspaceFolders.value = undefined;
});

describe('MessageRouter built-in routes', () => {
  it('ready → calls onReady', async () => {
    const { router, onReady } = makeRouter();
    await router.handle({ type: 'ready' });
    expect(onReady).toHaveBeenCalledOnce();
  });

  it('query → posts queryResult with the service data', async () => {
    const { router, postMessage } = makeRouter({
      runQuery: vi.fn().mockResolvedValue({ records: [{ Id: '1' }] }),
    });
    await router.handle({ type: 'query', soql: 'SELECT Id FROM Account' });
    expect(postMessage).toHaveBeenCalledWith({
      type: 'queryResult',
      data: { records: [{ Id: '1' }] },
    });
  });

  it('query failure → posts queryError with the message', async () => {
    const { router, postMessage } = makeRouter({
      runQuery: vi.fn().mockRejectedValue(new Error('bad soql')),
    });
    await router.handle({ type: 'query', soql: 'x' });
    expect(postMessage).toHaveBeenCalledWith({
      type: 'queryError',
      data: { message: 'bad soql' },
    });
  });

  it('operationStarted/Ended → mirror webview ops', async () => {
    const { router, operations } = makeRouter();
    await router.handle({ type: 'operationStarted', opId: 'op1' });
    await router.handle({ type: 'operationEnded', opId: 'op1' });
    expect(operations.startWebviewOp).toHaveBeenCalledWith('op1');
    expect(operations.endWebviewOp).toHaveBeenCalledWith('op1');
  });

  it('operationStarted without an opId is ignored', async () => {
    const { router, operations } = makeRouter();
    await router.handle({ type: 'operationStarted' });
    expect(operations.startWebviewOp).not.toHaveBeenCalled();
  });

  it('cancelOperation → cancels the terminal op', async () => {
    const { router, operations } = makeRouter();
    await router.handle({ type: 'cancelOperation', opId: 'op9' });
    expect(operations.cancelTerminalOp).toHaveBeenCalledWith('op9');
  });

  it('openRecord opens the record URL when an org is connected', async () => {
    const { router } = makeRouter({
      getCurrentOrg: vi.fn(() => ({ instanceUrl: 'https://x.my.salesforce.com' })),
    });
    await router.handle({ type: 'openRecord', recordId: '001ABC' });
    expect(openExternal).toHaveBeenCalledOnce();
    expect(openExternal.mock.calls[0][0]._raw).toBe('https://x.my.salesforce.com/001ABC');
  });

  it('openRecord is a no-op when no org is connected', async () => {
    const { router } = makeRouter({ getCurrentOrg: vi.fn(() => null) });
    await router.handle({ type: 'openRecord', recordId: '001' });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('openExternalUrl only opens http(s) urls', async () => {
    const { router } = makeRouter();
    await router.handle({ type: 'openExternalUrl', url: 'javascript:alert(1)' });
    expect(openExternal).not.toHaveBeenCalled();
    await router.handle({ type: 'openExternalUrl', url: 'https://ok.com' });
    expect(openExternal).toHaveBeenCalledOnce();
  });

  it('openInBrowser runs the command and always posts openInBrowserDone', async () => {
    executeCommand.mockResolvedValue(undefined);
    const { router, postMessage } = makeRouter();
    await router.handle({ type: 'openInBrowser' });
    expect(executeCommand).toHaveBeenCalledWith('forceCockpit.openInBrowser');
    expect(postMessage).toHaveBeenCalledWith({ type: 'openInBrowserDone' });
  });

  it('refreshOrg posts refreshOrgDone even if the command throws', async () => {
    executeCommand.mockRejectedValue(new Error('nope'));
    const { router, postMessage } = makeRouter();
    await expect(router.handle({ type: 'refreshOrg' })).rejects.toThrow();
    expect(postMessage).toHaveBeenCalledWith({ type: 'refreshOrgDone' });
  });

  it('confirmAction posts the modal answer back with the requestId', async () => {
    showWarningMessage.mockResolvedValue('Execute');
    const { router, postMessage } = makeRouter();
    await router.handle({ type: 'confirmAction', prompt: 'sure?', requestId: 'r1' });
    expect(postMessage).toHaveBeenCalledWith({
      type: 'confirmActionResult',
      data: { confirmed: true, requestId: 'r1' },
    });
  });

  it('confirmAction reports confirmed:false when the user dismisses', async () => {
    showWarningMessage.mockResolvedValue(undefined);
    const { router, postMessage } = makeRouter();
    await router.handle({ type: 'confirmAction', prompt: 'sure?', requestId: 'r2' });
    expect(postMessage).toHaveBeenCalledWith({
      type: 'confirmActionResult',
      data: { confirmed: false, requestId: 'r2' },
    });
  });

  it('exportQueryResult writes a timestamped file to the workspace root and opens it', async () => {
    workspaceFolders.value = [{ uri: { fsPath: '/ws' } }];
    writeFile.mockResolvedValue(undefined);
    const { router } = makeRouter();
    await router.handle({ type: 'exportQueryResult', content: 'a,b\r\n1,2', format: 'csv' });

    expect(writeFile).toHaveBeenCalledOnce();
    const [filePath, content] = writeFile.mock.calls[0];
    expect(filePath).toMatch(/\/ws\/query-result-\d{8}-\d{6}\.csv$/);
    expect(content).toBe('a,b\r\n1,2');
    expect(showTextDocument).toHaveBeenCalledOnce();
    expect(showTextDocument.mock.calls[0][0].fsPath).toBe(filePath);
  });

  it('exportQueryResult uses a .json extension for json format', async () => {
    workspaceFolders.value = [{ uri: { fsPath: '/ws' } }];
    writeFile.mockResolvedValue(undefined);
    const { router } = makeRouter();
    await router.handle({ type: 'exportQueryResult', content: '[]', format: 'json' });
    expect(writeFile.mock.calls[0][0]).toMatch(/\.json$/);
  });

  it('exportQueryResult shows an error when no workspace folder is open', async () => {
    workspaceFolders.value = undefined;
    const { router } = makeRouter();
    await router.handle({ type: 'exportQueryResult', content: 'x', format: 'csv' });
    expect(writeFile).not.toHaveBeenCalled();
    expect(showErrorMessage).toHaveBeenCalledOnce();
  });

  it('exportQueryResult surfaces a write failure via showErrorMessage', async () => {
    workspaceFolders.value = [{ uri: { fsPath: '/ws' } }];
    writeFile.mockRejectedValue(new Error('disk full'));
    const { router } = makeRouter();
    await router.handle({ type: 'exportQueryResult', content: 'x', format: 'csv' });
    expect(showErrorMessage).toHaveBeenCalledWith('Export failed: disk full');
  });
});

describe('MessageRouter feature routes', () => {
  function featureWith(handler: ReturnType<typeof vi.fn>): FeatureModule {
    return {
      id: 'f',
      tab: 'utils',
      htmlPath: '',
      jsPath: '',
      cssPath: '',
      routes: {
        doThing: { handler, successType: 'thingDone', errorType: 'thingFailed' },
      },
    };
  }

  it('dispatches to the matching feature route and echoes context (opId) on success', async () => {
    const handler = vi.fn().mockResolvedValue({ value: 42 });
    const { router, postMessage } = makeRouter({ features: [featureWith(handler)] });
    await router.handle({ type: 'doThing', opId: 'op7', extra: 'x' });
    expect(handler).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledWith({
      type: 'thingDone',
      data: expect.objectContaining({ value: 42, opId: 'op7', type: 'doThing', extra: 'x' }),
    });
  });

  it('echoes context (opId) on error too', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('kaboom'));
    const { router, postMessage } = makeRouter({ features: [featureWith(handler)] });
    await router.handle({ type: 'doThing', opId: 'op7' });
    expect(postMessage).toHaveBeenCalledWith({
      type: 'thingFailed',
      data: expect.objectContaining({ message: 'kaboom', opId: 'op7', type: 'doThing' }),
    });
  });

  it('wraps a non-object handler result under "result"', async () => {
    const handler = vi.fn().mockResolvedValue('plain string');
    const { router, postMessage } = makeRouter({ features: [featureWith(handler)] });
    await router.handle({ type: 'doThing' });
    expect(postMessage).toHaveBeenCalledWith({
      type: 'thingDone',
      data: expect.objectContaining({ result: 'plain string' }),
    });
  });

  it('creates and ends a terminal abort when the message carries an opId', async () => {
    const handler = vi.fn().mockResolvedValue({});
    const { router, operations } = makeRouter({ features: [featureWith(handler)] });
    await router.handle({ type: 'doThing', opId: 'op7' });
    expect(operations.createTerminalAbort).toHaveBeenCalledWith('op7');
    expect(operations.endTerminalOp).toHaveBeenCalledWith('op7');
  });

  it('ignores an unknown message type', async () => {
    const handler = vi.fn();
    const { router, postMessage } = makeRouter({ features: [featureWith(handler)] });
    await router.handle({ type: 'somethingNobodyHandles' });
    expect(handler).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });
});

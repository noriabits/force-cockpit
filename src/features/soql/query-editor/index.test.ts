import { beforeEach, describe, expect, it, vi } from 'vitest';

const { showErrorMessage, showTextDocument, writeFile, workspaceFolders } = vi.hoisted(() => ({
  showErrorMessage: vi.fn(),
  showTextDocument: vi.fn(),
  writeFile: vi.fn(),
  workspaceFolders: { value: undefined as unknown },
}));
vi.mock('vscode', () => ({
  window: { showErrorMessage, showTextDocument },
  workspace: {
    get workspaceFolders() {
      return workspaceFolders.value;
    },
  },
  Uri: { file: (s: string) => ({ fsPath: s, _file: s }) },
}));
vi.mock('fs', () => ({ promises: { writeFile } }));

const { runQuery, diagnose, stateStore } = vi.hoisted(() => ({
  runQuery: vi.fn(),
  diagnose: vi.fn(),
  stateStore: {
    getState: vi.fn(),
    saveTabs: vi.fn(),
    addHistory: vi.fn(),
    saveSavedQueries: vi.fn(),
  },
}));
vi.mock('./QueryService', () => ({
  QueryService: class {
    runQuery = runQuery;
  },
}));
vi.mock('./SoqlDiagnosticsService', () => ({
  SoqlDiagnosticsService: class {
    diagnose = diagnose;
  },
}));
vi.mock('./QueryStateStore', () => ({
  QueryStateStore: class {
    constructor() {
      return stateStore;
    }
  },
}));

import { createSoqlFeature } from './index';
import { MessageRouter } from '../../../panels/MessageRouter';
import type { ConnectionManager } from '../../../salesforce/connection';
import type { DescribeService } from '../../../services/describe/DescribeService';
import type { OperationRegistry } from '../../../panels/OperationRegistry';

/**
 * Drives the routes through a real MessageRouter, so these cover the generic
 * dispatch too: the opId/abort bookkeeping, the NO_REPLY silence and the
 * RouteError payload merge all live there.
 */
function makeRouter(opts: { operations?: Partial<OperationRegistry> } = {}) {
  const postMessage = vi.fn();
  const connectionManager = {} as ConnectionManager;
  const feature = createSoqlFeature({
    workspaceState: {} as never,
    describeService: {} as DescribeService,
  })(connectionManager);
  const operations = {
    startWebviewOp: vi.fn(),
    endWebviewOp: vi.fn(),
    cancelTerminalOp: vi.fn(),
    createTerminalAbort: vi.fn(() => new AbortController()),
    endTerminalOp: vi.fn(),
    ...opts.operations,
  } as unknown as OperationRegistry;

  const router = new MessageRouter({
    webview: { postMessage } as unknown as import('vscode').Webview,
    connectionManager,
    restCallService: {} as never,
    restCallStateStore: {} as never,
    describeService: {} as never,
    features: [feature],
    operations,
    onReady: vi.fn().mockResolvedValue(undefined),
  });
  return { router, postMessage, operations, feature };
}

beforeEach(() => {
  vi.clearAllMocks();
  workspaceFolders.value = undefined;
  runQuery.mockResolvedValue({ records: [], totalSize: 0, done: true });
  diagnose.mockResolvedValue([]);
  stateStore.getState.mockReturnValue({ tabs: [], activeTab: 0, history: [], savedQueries: [] });
  stateStore.saveTabs.mockResolvedValue(undefined);
  stateStore.addHistory.mockResolvedValue([]);
  stateStore.saveSavedQueries.mockResolvedValue([]);
});

describe('soql feature module', () => {
  it('declares the soql tab and its dist asset paths', () => {
    const { feature } = makeRouter();
    expect(feature.id).toBe('query-editor');
    expect(feature.tab).toBe('soql');
    expect(feature.htmlPath).toContain('soql');
    expect(feature.htmlPath).toContain('view.html');
    expect(Object.keys(feature.routes).sort()).toEqual([
      'addQueryHistory',
      'exportQueryResult',
      'loadQueryState',
      'query',
      'saveQueryTabs',
      'saveSavedQueries',
    ]);
  });
});

describe('query route', () => {
  it('posts queryResult with the service data', async () => {
    runQuery.mockResolvedValue({ records: [{ Id: '1' }], totalSize: 1, done: true });
    const { router, postMessage } = makeRouter();
    await router.handle({ type: 'query', soql: 'SELECT Id FROM Account' });
    expect(postMessage).toHaveBeenCalledWith({
      type: 'queryResult',
      data: {
        records: [{ Id: '1' }],
        totalSize: 1,
        done: true,
        type: 'query',
        soql: 'SELECT Id FROM Account',
      },
    });
  });

  it('forwards the useToolingApi flag to the service', async () => {
    const { router } = makeRouter();
    await router.handle({ type: 'query', soql: 'SELECT Id FROM ApexClass', useToolingApi: true });
    // No opId → no AbortController is registered, so the signal is undefined.
    expect(runQuery).toHaveBeenCalledWith('SELECT Id FROM ApexClass', true, undefined);
  });

  it('failure → posts queryError with the verbatim message', async () => {
    runQuery.mockRejectedValue(new Error('bad soql'));
    const { router, postMessage } = makeRouter();
    await router.handle({ type: 'query', soql: 'x' });
    expect(postMessage).toHaveBeenCalledWith({
      type: 'queryError',
      data: { type: 'query', soql: 'x', message: 'bad soql', diagnostics: [] },
    });
  });

  it('failure → attaches the diagnostics for the failed SOQL', async () => {
    const diagnostic = {
      severity: 'warning',
      title: "'AssetReferenceId__c' exists but field-level security is hiding it",
      detail: 'Ask an admin for Read access.',
    };
    diagnose.mockResolvedValue([diagnostic]);
    runQuery.mockRejectedValue(new Error("No such column 'AssetReferenceId__c'"));
    const { router, postMessage } = makeRouter();

    await router.handle({ type: 'query', soql: 'SELECT AssetReferenceId__c FROM QuoteLineItem' });

    expect(diagnose).toHaveBeenCalledWith(
      'SELECT AssetReferenceId__c FROM QuoteLineItem',
      "No such column 'AssetReferenceId__c'",
    );
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'queryError',
        data: expect.objectContaining({ diagnostics: [diagnostic] }),
      }),
    );
  });

  it('success → never runs diagnosis', async () => {
    const { router } = makeRouter();
    await router.handle({ type: 'query', soql: 'SELECT Id FROM Account' });
    expect(diagnose).not.toHaveBeenCalled();
  });

  it('with an opId registers an abort and echoes the opId back', async () => {
    const ac = new AbortController();
    const { router, postMessage, operations } = makeRouter({
      operations: { createTerminalAbort: vi.fn(() => ac) },
    });

    await router.handle({ type: 'query', soql: 'SELECT Id FROM Account', opId: 'soql-1' });

    expect(operations.createTerminalAbort).toHaveBeenCalledWith('soql-1');
    expect(runQuery).toHaveBeenCalledWith('SELECT Id FROM Account', undefined, ac.signal);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'queryResult',
        data: expect.objectContaining({ opId: 'soql-1' }),
      }),
    );
    expect(operations.endTerminalOp).toHaveBeenCalledWith('soql-1');
  });

  it('error echoes the opId so the webview can route it to the right tab', async () => {
    runQuery.mockRejectedValue(new Error('Malformed query'));
    const { router, postMessage } = makeRouter();

    await router.handle({ type: 'query', soql: 'SELECT Nope FROM Account', opId: 'soql-7' });

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'queryError',
        data: expect.objectContaining({ message: 'Malformed query', opId: 'soql-7' }),
      }),
    );
  });

  it('a cancelled query stays silent and skips the extra diagnostics round-trips', async () => {
    const ac = new AbortController();
    runQuery.mockImplementation(async () => {
      ac.abort();
      throw new Error('Operation cancelled');
    });
    const { router, postMessage, operations } = makeRouter({
      operations: { createTerminalAbort: vi.fn(() => ac) },
    });

    await router.handle({ type: 'query', soql: 'SELECT Id FROM Account', opId: 'soql-2' });

    expect(diagnose).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
    // Still released, so the panel does not stay busy forever.
    expect(operations.endTerminalOp).toHaveBeenCalledWith('soql-2');
  });
});

describe('query state routes', () => {
  it('loadQueryState → posts queryStateLoaded with the stored state', async () => {
    const state = {
      tabs: [{ name: 'Query 1', query: 'SELECT Id FROM Account', useToolingApi: false }],
      activeTab: 0,
      history: [],
      savedQueries: [],
    };
    stateStore.getState.mockReturnValue(state);
    const { router, postMessage } = makeRouter();
    await router.handle({ type: 'loadQueryState' });
    expect(postMessage).toHaveBeenCalledWith({
      type: 'queryStateLoaded',
      data: { ...state, type: 'loadQueryState' },
    });
  });

  it('saveQueryTabs → persists the tabs (fire-and-forget, no post)', async () => {
    const { router, postMessage } = makeRouter();
    const tabs = [{ name: 'A', query: 'q', useToolingApi: false }];
    await router.handle({ type: 'saveQueryTabs', tabs, activeTab: 0 });
    expect(stateStore.saveTabs).toHaveBeenCalledWith(tabs, 0);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('addQueryHistory → posts the updated history list', async () => {
    const history = [{ query: 'SELECT Id FROM Account', useToolingApi: false }];
    stateStore.addHistory.mockResolvedValue(history);
    const { router, postMessage } = makeRouter();
    await router.handle({
      type: 'addQueryHistory',
      query: 'SELECT Id FROM Account',
      useToolingApi: false,
    });
    expect(stateStore.addHistory).toHaveBeenCalledWith({
      query: 'SELECT Id FROM Account',
      useToolingApi: false,
    });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'queryHistoryUpdated',
        data: expect.objectContaining({ history }),
      }),
    );
  });

  it('saveSavedQueries → posts the stored saved-query list', async () => {
    const savedQueries = [
      { name: 'Accounts', query: 'SELECT Id FROM Account', useToolingApi: false },
    ];
    stateStore.saveSavedQueries.mockResolvedValue(savedQueries);
    const { router, postMessage } = makeRouter();
    await router.handle({ type: 'saveSavedQueries', savedQueries });
    expect(stateStore.saveSavedQueries).toHaveBeenCalledWith(savedQueries);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'savedQueriesUpdated',
        data: expect.objectContaining({ savedQueries }),
      }),
    );
  });
});

describe('exportQueryResult route', () => {
  it('writes a timestamped file to the workspace root and opens it', async () => {
    workspaceFolders.value = [{ uri: { fsPath: '/ws' } }];
    vi.setSystemTime(new Date('2026-06-11T14:30:45.123Z'));
    const { router, postMessage } = makeRouter();

    await router.handle({ type: 'exportQueryResult', content: 'a,b\n1,2', format: 'csv' });

    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining('query-result-20260611-143045.csv'),
      'a,b\n1,2',
      'utf8',
    );
    expect(showTextDocument).toHaveBeenCalled();
    // Reports through native dialogs only — never the webview.
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('uses a .json extension for json format', async () => {
    workspaceFolders.value = [{ uri: { fsPath: '/ws' } }];
    const { router } = makeRouter();
    await router.handle({ type: 'exportQueryResult', content: '[]', format: 'json' });
    expect(writeFile).toHaveBeenCalledWith(expect.stringMatching(/\.json$/), '[]', 'utf8');
  });

  it('warns natively and writes nothing without a workspace folder', async () => {
    const { router, postMessage } = makeRouter();
    await router.handle({ type: 'exportQueryResult', content: 'x', format: 'csv' });
    expect(writeFile).not.toHaveBeenCalled();
    expect(showErrorMessage).toHaveBeenCalledWith(
      'Open a workspace folder to export query results.',
    );
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('surfaces a write failure through a native dialog, not the webview', async () => {
    workspaceFolders.value = [{ uri: { fsPath: '/ws' } }];
    writeFile.mockRejectedValue(new Error('EACCES'));
    const { router, postMessage } = makeRouter();
    await router.handle({ type: 'exportQueryResult', content: 'x', format: 'csv' });
    expect(showErrorMessage).toHaveBeenCalledWith('Export failed: EACCES');
    expect(postMessage).not.toHaveBeenCalled();
  });
});

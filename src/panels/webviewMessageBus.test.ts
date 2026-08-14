import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as vm from 'vm';
import { fileURLToPath } from 'url';

// WebviewAssets imports vscode for its Uri helpers; only its static module list
// is read here, so an empty stub is enough to let it load.
vi.mock('vscode', () => ({}));

import { WebviewAssets } from './WebviewAssets';

// Locks the contract between the webview's two message buses. The host reply
// `listChatModelsResult` has consumers on BOTH — the SOQL AI panel subscribes
// via __onMessage (module bus) while Ask AI, Debug Logs and the YAML script form
// use __registerFeature({onMessage}) (feature bus). main.js used to `return` as
// soon as the module bus matched, which silently starved every feature-side
// consumer and left their model pickers empty.
//
// The real media/*.js files are evaluated here rather than mocked, so the test
// exercises the shipped registry. They are plain <script> IIFEs (no exports, and
// outside every tsconfig), hence the vm sandbox instead of an import.

const mediaPath = (relPath: string) =>
  fileURLToPath(new URL(`../../media/${relPath}`, import.meta.url));

interface Bootstrap {
  win: Record<string, any>;
  dispatch: (message: unknown) => void;
  postMessage: ReturnType<typeof vi.fn>;
}

/**
 * Load ipc.js then main.js into one context, the order webviews/main.html uses.
 * Each call gets a fresh window: ipc.js defines __vscode as non-configurable,
 * so a second evaluation against the same object would throw.
 */
function loadWebviewBootstrap(): Bootstrap {
  const listeners: Array<(event: { data: unknown }) => void> = [];
  const win: Record<string, any> = {
    addEventListener: (type: string, handler: (event: { data: unknown }) => void) => {
      if (type === 'message') listeners.push(handler);
    },
  };
  const postMessage = vi.fn();
  const sandbox = {
    window: win,
    acquireVsCodeApi: () => ({ postMessage }),
    console: { error: vi.fn(), log: vi.fn() },
  };

  vm.runInNewContext(fs.readFileSync(mediaPath('modules/ipc.js'), 'utf8'), sandbox);
  vm.runInNewContext(fs.readFileSync(mediaPath('main.js'), 'utf8'), sandbox);

  return {
    win,
    dispatch: (message: unknown) => listeners.forEach((l) => l({ data: message })),
    postMessage,
  };
}

describe('webview message bus', () => {
  it('delivers a message to the module bus AND the feature bus', () => {
    // The regression: with the old early return, moduleHandler firing meant
    // featureHandler never did.
    const { win, dispatch } = loadWebviewBootstrap();
    const moduleHandler = vi.fn();
    const featureHandler = vi.fn();
    win.__onMessage('listChatModelsResult', moduleHandler);
    win.__registerFeature('ask-ai', { onMessage: featureHandler });

    const message = { type: 'listChatModelsResult', data: { models: [] } };
    dispatch(message);

    expect(moduleHandler).toHaveBeenCalledTimes(1);
    expect(featureHandler).toHaveBeenCalledTimes(1);
    expect(featureHandler).toHaveBeenCalledWith(message);
  });

  it('fans a shared streaming chunk out to every registered consumer', () => {
    // scriptLogChunk is the other type with consumers on both buses; each one
    // filters by its own opId.
    const { win, dispatch } = loadWebviewBootstrap();
    const soqlPanel = vi.fn();
    const askAi = vi.fn();
    const debugLogs = vi.fn();
    win.__onMessage('scriptLogChunk', soqlPanel);
    win.__registerFeature('ask-ai', { onMessage: askAi });
    win.__registerFeature('debug-logs', { onMessage: debugLogs });

    dispatch({ type: 'scriptLogChunk', data: { opId: 'op-1', chunk: 'hello' } });

    expect(soqlPanel).toHaveBeenCalledTimes(1);
    expect(askAi).toHaveBeenCalledTimes(1);
    expect(debugLogs).toHaveBeenCalledTimes(1);
  });

  it('still reaches features when no module handler is registered for the type', () => {
    const { win, dispatch } = loadWebviewBootstrap();
    const featureHandler = vi.fn();
    win.__registerFeature('ask-ai', { onMessage: featureHandler });

    dispatch({ type: 'askAiAnswer', data: {} });

    expect(featureHandler).toHaveBeenCalledTimes(1);
  });

  it('still reaches module handlers when no feature is registered', () => {
    const { win, dispatch } = loadWebviewBootstrap();
    const moduleHandler = vi.fn();
    win.__onMessage('queryResult', moduleHandler);

    dispatch({ type: 'queryResult', data: {} });

    expect(moduleHandler).toHaveBeenCalledTimes(1);
  });

  it('drops a message belonging to a cancelled operation before either bus runs', () => {
    const { win, dispatch } = loadWebviewBootstrap();
    const moduleHandler = vi.fn();
    const featureHandler = vi.fn();
    win.__onMessage('scriptLogChunk', moduleHandler);
    win.__registerFeature('ask-ai', { onMessage: featureHandler });
    win.__isOpCancelled = vi.fn(() => true);
    win.__clearCancelledOp = vi.fn();

    dispatch({ type: 'scriptLogChunk', opId: 'op-9', data: {} });

    expect(moduleHandler).not.toHaveBeenCalled();
    expect(featureHandler).not.toHaveBeenCalled();
    expect(win.__clearCancelledOp).toHaveBeenCalledWith('op-9');
  });

  it('tolerates a feature registered without an onMessage handler', () => {
    const { win, dispatch } = loadWebviewBootstrap();
    const featureHandler = vi.fn();
    win.__registerFeature('no-handler', { onOrgConnected: () => {} });
    win.__registerFeature('ask-ai', { onMessage: featureHandler });

    expect(() => dispatch({ type: 'askAiAnswer', data: {} })).not.toThrow();
    expect(featureHandler).toHaveBeenCalledTimes(1);
  });

  it('isolates a throwing feature handler so later features still receive the message', () => {
    const { win, dispatch } = loadWebviewBootstrap();
    const throwing = vi.fn(() => {
      throw new Error('handler blew up');
    });
    const later = vi.fn();
    win.__registerFeature('throwing', { onMessage: throwing });
    win.__registerFeature('later', { onMessage: later });

    expect(() => dispatch({ type: 'askAiAnswer', data: {} })).not.toThrow();
    expect(later).toHaveBeenCalledTimes(1);
  });

  it('isolates a throwing module handler from its siblings on the same type', () => {
    const { win, dispatch } = loadWebviewBootstrap();
    const throwing = vi.fn(() => {
      throw new Error('handler blew up');
    });
    const sibling = vi.fn();
    win.__onMessage('orgConnected', throwing);
    win.__onMessage('orgConnected', sibling);

    expect(() => dispatch({ type: 'orgConnected', data: {} })).not.toThrow();
    expect(sibling).toHaveBeenCalledTimes(1);
  });

  it('signals readiness to the host once at load', () => {
    const { postMessage } = loadWebviewBootstrap();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({ type: 'ready' });
  });

  it('loads ipc.js first, since every other module depends on its globals', () => {
    // Guarded only by a comment in WebviewAssets until now.
    expect(WebviewAssets.WEBVIEW_MODULES[0]).toBe('media/modules/ipc.js');
  });
});

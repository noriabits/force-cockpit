// ▶️ Apex — entry of the bundle (dist/features/debug-logs/anonymous-apex/view.js).
// Mounts into `#apex-card` from view.html, registers the host handlers, and asks
// for the persisted tabs.
//
// Same lifecycle as the REST tab (see src/webview/rest-call/index.tsx): Preact's
// initial render is synchronous INCLUDING apex-tab.tsx's useLayoutEffect, so the
// collaborators exist by the time the handlers below are registered and the
// state request goes out. Unlike REST this is a deferred feature script, which
// runs after media/main.js has installed the message listener — so the reply to
// `loadApexState` always has somewhere to land.
import { render } from 'preact';
import { on, post } from '../../../shared/view/host';
import { createApexController, createApexState } from './apex-controller';
import { ApexTab } from './apex-tab';

const state = createApexState();
const controller = createApexController(state);

const mount = document.getElementById('apex-card');
if (mount) {
  render(<ApexTab state={state} controller={controller} />, mount);

  const { handlers } = controller;
  on('anonymousApexExecuted', handlers.anonymousApexExecuted);
  on('anonymousApexError', handlers.anonymousApexError);
  on('apexStateLoaded', handlers.apexStateLoaded);
  on('apexHistoryUpdated', handlers.apexHistoryUpdated);
  on('apexSavedSnippetsUpdated', handlers.apexSavedSnippetsUpdated);
  on('cancelAllOperations', handlers.cancelAllOperations);

  // A run's reply belongs to the org it was sent to. An org-to-org switch fires
  // only the connect edge, so both are handled.
  (
    window as unknown as {
      __registerFeature: (id: string, h: Record<string, () => void>) => void;
    }
  ).__registerFeature('anonymous-apex', {
    onOrgConnected: () => controller.stopAllRuns(),
    onOrgDisconnected: () => controller.stopAllRuns(),
  });

  post({ type: 'loadApexState' });
}

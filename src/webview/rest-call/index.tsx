// REST tab — call arbitrary REST / Apex REST endpoints on the connected org.
// A bar of request tabs over one shared editing surface (method + endpoint + body
// + headers). Tabs persist through saveRestCallTabs and are restored by
// loadRestCallState. Bundled by esbuild into dist/webview/rest-call.js.
//
// LIFECYCLE — the ordering below is load-bearing, and this comment is the record.
//
// 1. State and the controller are created at module scope. Neither touches the
//    DOM, which is what lets the tab strip's construction tail call writeUI
//    before any element exists.
// 2. render() mounts the tree. Preact's initial render into an empty container is
//    synchronous INCLUDING its useLayoutEffect callbacks, so rest-tab.tsx's mount
//    effect — which builds the headers editor, response view, tab strip and
//    history over the freshly rendered DOM — has completed by the time render()
//    returns. That is why steps 3 and 4 can be plain module-scope statements with
//    no null guards: the collaborators are already there.
// 3. The host handlers are registered.
// 4. loadRestCallState is posted, exactly as it was the last statement before.
//
// Two invariants that keep the reply-before-mount window EMPTY rather than merely
// unlikely, and that a future change could quietly break:
//   - rest-tab.tsx's mount effect must stay useLayoutEffect. A useEffect is
//     deferred past render(), so step 3 would register against an unbuilt
//     controller and step 4 would ask for state nothing could receive.
//   - This bundle must stay a synchronous <script> BEFORE media/main.js in
//     WebviewAssets.WEBVIEW_MODULES. main.js installs the single `message`
//     listener, so until it runs no host reply can reach any handler. Adding
//     `defer` here, or moving this entry later in that list, reopens the window.

import { render } from 'preact';
import { on, post } from '../../features/shared/view/host';
import { createRestState, createRestController } from './rest-controller';
import { RestTab } from './rest-tab';

const state = createRestState();
const controller = createRestController(state);

const mount = document.getElementById('restcall-card');
if (mount) {
  render(<RestTab state={state} controller={controller} />, mount);

  const { handlers } = controller;
  on('restCallResult', handlers.restCallResult);
  on('restCallError', handlers.restCallError);
  on('restCallStateLoaded', handlers.restCallStateLoaded);
  on('restCallHistoryUpdated', handlers.restCallHistoryUpdated);
  on('restCallSavedRequestsUpdated', handlers.restCallSavedRequestsUpdated);
  on('cancelAllOperations', handlers.cancelAllOperations);

  // A reply from the org that was connected when the request went out must never
  // land in a tab now pointed at a different org. An org-to-org switch fires only
  // the connect edge, so both are handled.
  (
    window as unknown as {
      __registerFeature: (id: string, h: Record<string, () => void>) => void;
    }
  ).__registerFeature('rest-call', {
    onOrgConnected: () => controller.stopAllRuns(),
    onOrgDisconnected: () => controller.stopAllRuns(),
  });

  post({ type: 'loadRestCallState' });
}

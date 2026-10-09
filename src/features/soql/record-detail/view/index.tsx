// Record Detail — entry of the bundle (dist/features/soql/record-detail/view.js).
// Mounts into `#record-detail-root` from view.html, registers the host
// handlers, and exposes `win.__showRecordDetail(id)` for other bundles.
//
// `__showRecordDetail` is the cross-bundle seam: the SOQL results table lives in a
// different esbuild bundle (its own Preact, its own module scope), so it cannot
// import this controller. A window global is the same mechanism every other
// cross-module call uses (`__confirmIfSensitive`, `__clearQueryResults`). It
// switches to the SOQL tab and this sub-tab before loading, so it works from
// wherever it is called.
import { render } from 'preact';
import { on } from '../../../shared/view/host';
import { createRecordDetailController, createRecordDetailState } from './record-detail-controller';
import { RecordDetail } from './record-detail';

interface CockpitWindow {
  __registerFeature: (id: string, h: Record<string, () => void>) => void;
  __activateTab: (tabId: string) => void;
  __activateSubTab: (barId: string, id: string) => void;
  __showRecordDetail?: (id: string) => void;
}
const win = window as unknown as CockpitWindow;

const state = createRecordDetailState();
const controller = createRecordDetailController(state);

const mount = document.getElementById('record-detail-root');
if (mount) {
  render(<RecordDetail state={state} controller={controller} />, mount);

  const { handlers } = controller;
  on('recordDetailLoaded', handlers.recordDetailLoaded);
  on('loadRecordDetailError', handlers.loadRecordDetailError);
  on('recordChangesSaved', handlers.recordChangesSaved);
  on('saveRecordChangesError', handlers.saveRecordChangesError);
  on('cancelAllOperations', () => controller.cancel());

  // The record on screen belongs to the org it was read from. An org-to-org
  // switch fires only the connect edge, so both edges reset.
  win.__registerFeature('record-detail', {
    onOrgConnected: () => controller.reset(),
    onOrgDisconnected: () => controller.reset(),
  });

  win.__showRecordDetail = (id: string) => {
    win.__activateTab('soql');
    win.__activateSubTab('soql-sub-tab-bar', 'record-detail');
    controller.loadFromElsewhere(id);
  };
}

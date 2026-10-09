// The ▶️ Apex tab's editing surface and outcome panel, rendered into #apex-card.
// The parsed log is NOT here — it is the Debug Logs viewer's static card in
// view.html (see apex-controller.tsx).
//
// LOAD-BEARING — UNCONTROLLED LEAVES, same rule as the REST tab (rest-tab.tsx):
//   .query-tab-bar          tab-strip.js owns its children outright.
//   .query-history-dropdown history-dropdown.tsx mounts its own render root and
//                           drives this element's `display` from an effect.
// Both are rendered with no children and no `style` prop, unconditionally and at
// a fixed position, so Preact's diff never replaces a node its owner still holds.

import { useLayoutEffect, useRef } from 'preact/hooks';
import type { AnonymousApexOutcome } from '../../../../shared/protocol';
import { DEBUG_LEVEL_PRESETS } from '../../explorer/debugLevelPresets';
import type { ApexDisplay, ApexViewState, createApexController } from './apex-controller';

type Controller = ReturnType<typeof createApexController>;

interface LabelsWindow {
  AnonymousApexLabels: Record<string, string> & {
    atPosition: (line: number, column: number | null) => string;
    goToLine: (line: number) => string;
  };
}
const L = () => (window as unknown as LabelsWindow).AnonymousApexLabels;

const INDENT = '  ';

export function ApexTab({ state, controller }: { state: ApexViewState; controller: Controller }) {
  const tabBar = useRef<HTMLDivElement | null>(null);
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const historyButton = useRef<HTMLButtonElement | null>(null);
  const historyDropdown = useRef<HTMLDivElement | null>(null);
  const historySave = useRef<HTMLButtonElement | null>(null);

  // useLayoutEffect, NEVER useEffect: index.tsx registers the host handlers and
  // posts loadApexState right after render() returns, and both need the
  // collaborators built by then.
  useLayoutEffect(() => {
    controller.attach({
      tabBarEl: tabBar.current!,
      textareaEl: textarea.current!,
      historyButtonEl: historyButton.current!,
      historyDropdownEl: historyDropdown.current!,
      historySaveBtn: historySave.current!,
    });
  }, []);

  const setCode = (code: string) => {
    state.code.value = code;
    controller.onEdited();
  };

  function onKeyDown(e: KeyboardEvent) {
    const el = e.currentTarget as HTMLTextAreaElement;
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      controller.execute();
    } else if (e.key === 'Tab' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // A code editor that Tabs out of itself is unusable; indent instead.
      e.preventDefault();
      el.setRangeText(INDENT, el.selectionStart, el.selectionEnd, 'end');
      setCode(el.value);
    }
  }

  const running = state.runningOpId.value !== null;
  const L_ = L();

  return (
    <>
      <div class="query-tab-bar" ref={tabBar} />

      <textarea
        class="apex-editor"
        ref={textarea}
        spellcheck={false}
        rows={10}
        placeholder={L_.editorPlaceholder}
        aria-label="Anonymous Apex"
        value={state.code.value}
        onInput={(e) => setCode(e.currentTarget.value)}
        onKeyDown={onKeyDown}
      />

      <div class="query-toolbar">
        <button
          class={`btn btn-primary${running ? ' running' : ''}`}
          disabled={running}
          onClick={() => controller.execute()}
        >
          {L_.execute}
        </button>
        {running && (
          <button
            type="button"
            class="btn btn-ghost action-cancel-btn"
            onClick={() => controller.cancelActiveRun()}
          >
            {L_.cancel}
          </button>
        )}
        <button
          class="btn btn-ghost"
          data-tooltip={L_.cloneTooltip}
          aria-label={L_.cloneTooltip}
          onClick={() => controller.cloneActiveTab()}
        >
          {L_.clone}
        </button>
        <div class="query-history-wrap">
          <button class="btn btn-ghost" ref={historyButton}>
            {L_.history}
          </button>
          <div class="query-history-dropdown" ref={historyDropdown} />
        </div>
        <button
          class="btn btn-ghost"
          data-tooltip={L_.saveTooltip}
          aria-label={L_.saveTooltip}
          ref={historySave}
        >
          {L_.save}
        </button>
        <button
          class="btn btn-ghost"
          data-tooltip={L_.saveAsScriptTooltip}
          aria-label={L_.saveAsScriptTooltip}
          onClick={() => controller.saveAsScript()}
        >
          {L_.saveAsScript}
        </button>
        <span class="query-toolbar-spacer" />
        <label class="apex-option" data-tooltip={L_.presetTooltip}>
          {L_.presetLabel}
          <select
            class="text-input apex-preset"
            value={state.presetId.value}
            onChange={(e) => controller.setPreset(e.currentTarget.value)}
          >
            {DEBUG_LEVEL_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {running && <div class="status-hint apex-running">{L_.running}</div>}
      <Outcome display={state.display.value} onGoToLine={controller.goToLine} />
    </>
  );
}

function Outcome({
  display,
  onGoToLine,
}: {
  display: ApexDisplay;
  onGoToLine: (line: number, column: number | null) => void;
}) {
  if (!display) return null;
  if (display.kind === 'error') {
    return <div class="apex-outcome apex-outcome--error">{display.message}</div>;
  }
  if (display.kind === 'cancelled') {
    return <div class="apex-outcome apex-outcome--warn">{L().cancelled}</div>;
  }
  return <OutcomeResult outcome={display.outcome} onGoToLine={onGoToLine} />;
}

function OutcomeResult({
  outcome,
  onGoToLine,
}: {
  outcome: AnonymousApexOutcome;
  onGoToLine: (line: number, column: number | null) => void;
}) {
  const L_ = L();
  if (!outcome.compiled) {
    const { line, column } = outcome;
    return (
      <div class="apex-outcome apex-outcome--error">
        <div class="apex-outcome-title">
          {L_.compileError}
          {line !== null && ` — ${L_.atPosition(line, column)}`}
        </div>
        <pre class="apex-outcome-detail">{outcome.compileProblem}</pre>
        {line !== null && (
          <button type="button" class="btn btn-ghost" onClick={() => onGoToLine(line, column)}>
            {L_.goToLine(line)}
          </button>
        )}
      </div>
    );
  }
  if (!outcome.success) {
    return (
      <div class="apex-outcome apex-outcome--error">
        <div class="apex-outcome-title">{L_.exception}</div>
        <pre class="apex-outcome-detail">
          {[outcome.exceptionMessage, outcome.exceptionStackTrace].filter(Boolean).join('\n')}
        </pre>
      </div>
    );
  }
  return (
    <div class="apex-outcome apex-outcome--ok">
      <div class="apex-outcome-title">{L_.success}</div>
      {!outcome.log && <div class="status-hint">{L_.noLog}</div>}
    </div>
  );
}

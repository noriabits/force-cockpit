// The REST tab's editing surface: request row, headers section, body, toolbar,
// and the two output containers. Rendered into #restcall-card, which is now the
// only REST markup left in webviews/main.html.
//
// LOAD-BEARING — FOUR UNCONTROLLED LEAVES. These are rendered with NO children
// and NO `style` prop, because a module outside Preact owns what goes in them:
//
//   .query-tab-bar          tab-strip.js does `innerHTML = ''`, stashes `__tab`
//                           on each pill, reads tab order back OUT of the DOM in
//                           commitTabOrder, and re-orders nodes during a drag.
//   .rest-headers-list      headers-editor.js does `innerHTML = ''`, and is
//                           shared with yaml-scripts' imperative `rest:` form.
//   .query-history-dropdown history.tsx mounts its own render root here and
//                           drives this element's `display` from an effect.
//   .rest-response          response-view.tsx does the same.
//   .error-box              written with textContent by response-view.tsx, and
//                           relies on the global `.error-box:empty` rule, which
//                           a Preact-rendered `{''}` child would defeat (an empty
//                           Text node is still a child node).
//
// Each must also be rendered UNCONDITIONALLY, at a fixed position, with no key
// change: if Preact ever replaces one of these nodes, its imperative owner is
// left holding a detached element and the listeners it wired at construction are
// silently gone.
//
// The two nested render roots are deliberate, not an accident of the migration
// order: they isolate the response body from this component's diff, so typing in
// the endpoint field cannot re-diff a megabyte of pretty-printed JSON.

import { useLayoutEffect, useRef } from 'preact/hooks';
import type { RestState, createRestController } from './rest-controller';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

type Controller = ReturnType<typeof createRestController>;

export function RestTab({ state, controller }: { state: RestState; controller: Controller }) {
  const tabBar = useRef<HTMLDivElement | null>(null);
  const headersList = useRef<HTMLDivElement | null>(null);
  const addHeader = useRef<HTMLButtonElement | null>(null);
  const response = useRef<HTMLDivElement | null>(null);
  const error = useRef<HTMLDivElement | null>(null);
  const historyButton = useRef<HTMLButtonElement | null>(null);
  const historyDropdown = useRef<HTMLDivElement | null>(null);
  const historySave = useRef<HTMLButtonElement | null>(null);

  // useLayoutEffect, NEVER useEffect. index.tsx registers the host handlers and
  // posts loadRestCallState immediately after render() returns, and both need the
  // collaborators built by then — a deferred effect would leave them undefined.
  useLayoutEffect(() => {
    controller.attach({
      tabBarEl: tabBar.current!,
      headersListEl: headersList.current!,
      addHeaderBtn: addHeader.current!,
      responseEl: response.current!,
      errorEl: error.current!,
      historyButtonEl: historyButton.current!,
      historyDropdownEl: historyDropdown.current!,
      historySaveBtn: historySave.current!,
    });
  }, []);

  const edit =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      controller.onEdited();
    };

  const running = state.runningOpId.value !== null;

  return (
    <>
      <div class="query-tab-bar" ref={tabBar} />

      <div class="rest-request-row">
        <select
          class="text-input rest-method"
          aria-label="HTTP method"
          value={state.method.value}
          onChange={(e) => edit<string>((v) => (state.method.value = v))(e.currentTarget.value)}
        >
          {METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        {/* The paste button's delegated handler resolves its target as
            previousElementSibling, so the input must stay immediately before it. */}
        <div class="input-with-paste" style={{ width: '100%' }}>
          <input
            type="text"
            class="text-input rest-endpoint"
            spellcheck={false}
            placeholder="/services/data/v65.0/sobjects/Account"
            aria-label="Endpoint path"
            value={state.endpoint.value}
            onInput={(e) => edit<string>((v) => (state.endpoint.value = v))(e.currentTarget.value)}
          />
          <button
            type="button"
            class="paste-btn"
            tabIndex={-1}
            data-tooltip="Paste from clipboard"
            aria-label="Paste endpoint from clipboard"
          >
            📋
          </button>
        </div>
      </div>

      <div class="rest-headers-section">
        <div class="rest-headers-section-title">Headers</div>
        <div class="rest-headers-list" ref={headersList} />
        <button type="button" class="btn btn-ghost" ref={addHeader}>
          + Add header
        </button>
      </div>

      {/* Same wrapper + adjacency contract as the endpoint above; the --textarea
          modifier top-aligns the button beside a control many times its height.
          A pasted body arrives as an external `value` write plus a synthetic
          `input` event, which is why the signal below stays in step with it. */}
      <div class="input-with-paste input-with-paste--textarea">
        <textarea
          class="rest-body-textarea"
          spellcheck={false}
          placeholder="{ }"
          rows={6}
          value={state.body.value}
          onInput={(e) => edit<string>((v) => (state.body.value = v))(e.currentTarget.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              controller.send();
            }
          }}
        />
        <button
          type="button"
          class="paste-btn"
          tabIndex={-1}
          data-tooltip="Paste from clipboard"
          aria-label="Paste request body from clipboard"
        >
          📋
        </button>
      </div>

      <div class="query-toolbar">
        <button
          class={`btn btn-primary${running ? ' running' : ''}`}
          disabled={running}
          onClick={() => controller.send()}
        >
          Send
        </button>
        {/* Was injected imperatively next to Send; now simply its sibling. */}
        {running && (
          <button
            type="button"
            class="btn btn-ghost action-cancel-btn"
            onClick={() => controller.cancelActiveRun()}
          >
            ✕ Cancel
          </button>
        )}
        <button
          class="btn btn-ghost"
          data-tooltip="Clone the current tab into a new tab"
          aria-label="Clone the current request tab"
          onClick={() => controller.cloneActiveTab()}
        >
          ⧉ Clone
        </button>
        <div class="query-history-wrap">
          <button class="btn btn-ghost" ref={historyButton}>
            History ▾
          </button>
          <div class="query-history-dropdown" ref={historyDropdown} />
        </div>
        <button
          class="btn btn-ghost"
          data-tooltip="Save current request"
          aria-label="Save current request"
          ref={historySave}
        >
          ★ Save
        </button>
      </div>

      <div class="rest-response" ref={response} />
      <div class="error-box" ref={error} />
    </>
  );
}

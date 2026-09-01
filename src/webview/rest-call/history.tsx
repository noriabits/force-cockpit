// Request history dropdown for the REST tab: a "History ▾" button that opens a
// panel with two sections — Saved (named, removable) and Recent (auto-recorded).
// Persistence lives host-side (RestCallStateStore); this module posts
// addRestCallHistory / saveRestCallSavedRequests and re-renders on the host's
// replies.
//
// The first Preact component in this bundle. The public shape is unchanged —
// `createRestCallHistory(ctx)` still returns { load, recordRun, onHistoryUpdated,
// onSavedUpdated } and still takes the same pre-existing DOM elements — so
// index.js was untouched by this port. What changed is that the panel's five
// build* functions (~130 lines of createElement) became JSX over four signals.
//
// The signals are module-instance state created by the factory, NOT `useSignal`
// hooks: the REST tab is a singleton, and `load()`/`onHistoryUpdated()` are called
// from the host message handlers — outside any component — so the state has to be
// reachable from there. Reading a signal outside a render creates no subscription.
//
// LOAD-BEARING: `dropdownEl` is the mount CONTAINER. Preact owns its children;
// its own `display` is written by the effect below, so once this panel is rendered
// by a parent component (rather than mounted into static markup) that element must
// be an uncontrolled leaf — no `style` prop — or the diff will fight the effect.

import { render } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { signal, effect, type Signal } from '@preact/signals';

export interface HeaderEntry {
  key: string;
  value: string;
}
export interface RestHistoryEntry {
  method: string;
  endpoint: string;
  body: string;
  headers: HeaderEntry[];
}
export interface SavedRestCall extends RestHistoryEntry {
  name: string;
}
/** A row's payload plus, for a Saved row only, the label the opened tab adopts. */
export type PickedEntry = RestHistoryEntry & { name?: string };

export interface RestCallHistoryCtx {
  /** "History ▾" toggle. */
  buttonEl: HTMLButtonElement;
  /** Mount container for the panel — see the load-bearing note above. */
  dropdownEl: HTMLElement;
  /** "★ Save" current request. */
  saveBtn: HTMLButtonElement;
  vscode: { postMessage: (msg: unknown) => void };
  getCurrent: () => RestHistoryEntry;
  onPick: (entry: PickedEntry) => void;
  /**
   * Name to pre-fill the save input with — the active tab's own title, whether
   * auto-derived, hand-renamed or adopted from a saved entry. Pre-selected, so
   * typing still replaces it.
   */
  getDefaultName?: () => string;
  /**
   * Called once a Save is confirmed, with the name it was saved under — lets the
   * caller relabel the tab that was just saved to match, so the box the user just
   * typed a name into and the tab they're looking at never disagree.
   */
  onSaved?: (name: string) => void;
}

/** The method is already shown in the badge, so the item text is just the endpoint. */
function itemText(item: { endpoint: string }): string {
  const oneLine = item.endpoint.replace(/\s+/g, ' ').trim();
  return oneLine.length > 70 ? oneLine.slice(0, 70) + '…' : oneLine;
}

/**
 * Tooltips come from a webview global (media/modules/tooltip.js), which sets a
 * `data-tooltip` attribute and an aria-label together. Applied through a ref
 * rather than as JSX attributes so there stays exactly one helper doing both.
 */
function useTooltip<T extends HTMLElement>(text: string) {
  const ref = useRef<T | null>(null);
  useLayoutEffect(() => {
    if (ref.current) (window as unknown as CockpitTooltips).__setTooltip(ref.current, text);
  }, [text]);
  return ref;
}
interface CockpitTooltips {
  __setTooltip: (el: Element, text: string) => void;
}

interface PanelState {
  history: Signal<RestHistoryEntry[]>;
  saved: Signal<SavedRestCall[]>;
  open: Signal<boolean>;
  showSaveRow: Signal<boolean>;
}

function SaveRow({ ctx, state }: { ctx: RestCallHistoryCtx; state: PanelState }) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  // The input is a genuine uncontrolled leaf: seeded once here, then owned by the
  // DOM. Deliberately NOT a `value` prop — the panel re-renders whenever the host
  // pushes an updated list, and a bound value would reset the box mid-typing.
  //
  // Focus AND select because the pre-filled tab name is a suggestion, so typing
  // over it has to be as cheap as accepting it. A layout effect rather than the
  // old setTimeout(0): the row is in the DOM by the time this runs.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.value = (ctx.getDefaultName?.() ?? '').trim();
    el.focus();
    el.select();
  }, []);

  const commit = () => {
    const name = inputRef.current?.value.trim() ?? '';
    if (!name) return;
    const cur = ctx.getCurrent();
    if (!cur.endpoint.trim()) return;
    state.saved.value = [
      { name, method: cur.method, endpoint: cur.endpoint, body: cur.body, headers: cur.headers },
      ...state.saved.value.filter((s) => s.name !== name),
    ];
    ctx.vscode.postMessage({
      type: 'saveRestCallSavedRequests',
      savedRequests: state.saved.value,
    });
    ctx.onSaved?.(name);
    state.showSaveRow.value = false;
  };

  return (
    <div class="query-history-save-row">
      <input
        ref={inputRef}
        type="text"
        class="query-history-save-input"
        placeholder="Name this request…"
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            state.showSaveRow.value = false;
          }
        }}
      />
      <button type="button" class="btn btn-ghost" onClick={commit}>
        Save
      </button>
    </div>
  );
}

function Row({
  item,
  isSaved,
  onPick,
  onRemove,
}: {
  item: RestHistoryEntry | SavedRestCall;
  isSaved: boolean;
  onPick: (entry: PickedEntry) => void;
  onRemove: () => void;
}) {
  const name = (item as SavedRestCall).name;
  const labelRef = useTooltip<HTMLSpanElement>(`${item.method} ${item.endpoint}`);
  const removeRef = useTooltip<HTMLButtonElement>('Remove saved request');

  return (
    <div class="query-history-item">
      <span class="query-history-tooling-badge">{item.method}</span>
      <span
        ref={labelRef}
        class="query-history-item-label"
        onClick={() =>
          onPick({
            method: item.method,
            endpoint: item.endpoint,
            body: item.body,
            headers: item.headers || [],
            name: isSaved ? name : undefined,
          })
        }
      >
        {isSaved ? name : itemText(item)}
      </span>
      {isSaved && (
        <button
          ref={removeRef}
          type="button"
          class="query-history-remove"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

function Section({
  title,
  items,
  isSaved,
  onPick,
  onRemove,
}: {
  title: string;
  items: (RestHistoryEntry | SavedRestCall)[];
  isSaved: boolean;
  onPick: (entry: PickedEntry) => void;
  onRemove: (item: RestHistoryEntry | SavedRestCall) => void;
}) {
  return (
    <div class="query-history-section">
      <div class="query-history-section-title">{`${title} (${items.length})`}</div>
      {items.length === 0 ? (
        <div class="query-history-empty">
          {isSaved ? 'No saved requests.' : 'No recent requests.'}
        </div>
      ) : (
        items.map((item, i) => (
          <Row
            key={i}
            item={item}
            isSaved={isSaved}
            onPick={onPick}
            onRemove={() => onRemove(item)}
          />
        ))
      )}
    </div>
  );
}

function HistoryPanel({ ctx, state }: { ctx: RestCallHistoryCtx; state: PanelState }) {
  // Closed renders nothing at all, matching the old build-on-open behaviour: no
  // stale rows sit in the DOM, and a pick can never reach a hidden panel.
  if (!state.open.value) return null;

  const pick = (entry: PickedEntry) => {
    ctx.onPick(entry);
    state.open.value = false;
    state.showSaveRow.value = false;
  };
  const remove = (item: RestHistoryEntry | SavedRestCall) => {
    state.saved.value = state.saved.value.filter((s) => s !== item);
    ctx.vscode.postMessage({
      type: 'saveRestCallSavedRequests',
      savedRequests: state.saved.value,
    });
  };

  return (
    <>
      {state.showSaveRow.value && <SaveRow ctx={ctx} state={state} />}
      <Section title="Saved" items={state.saved.value} isSaved onPick={pick} onRemove={remove} />
      <Section
        title="Recent"
        items={state.history.value}
        isSaved={false}
        onPick={pick}
        onRemove={remove}
      />
    </>
  );
}

export function createRestCallHistory(ctx: RestCallHistoryCtx) {
  const state: PanelState = {
    history: signal<RestHistoryEntry[]>([]),
    saved: signal<SavedRestCall[]>([]),
    open: signal(false),
    showSaveRow: signal(false),
  };

  const close = () => {
    state.open.value = false;
    state.showSaveRow.value = false;
  };

  render(<HistoryPanel ctx={ctx} state={state} />, ctx.dropdownEl);
  // The container's own visibility, derived rather than set at each call site —
  // which is what lets the parent render it as a leaf with no style prop.
  effect(() => {
    ctx.dropdownEl.style.display = state.open.value ? '' : 'none';
  });

  ctx.buttonEl.addEventListener('click', (e) => {
    e.stopPropagation();
    if (state.open.value) close();
    else state.open.value = true;
  });
  ctx.saveBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    state.open.value = true;
    state.showSaveRow.value = true;
  });
  document.addEventListener('click', (e) => {
    if (
      state.open.value &&
      !ctx.dropdownEl.contains(e.target as Node) &&
      e.target !== ctx.buttonEl
    ) {
      close();
    }
  });

  return {
    load(loaded: { history?: RestHistoryEntry[]; savedRequests?: SavedRestCall[] }) {
      state.history.value = Array.isArray(loaded.history) ? loaded.history : [];
      state.saved.value = Array.isArray(loaded.savedRequests) ? loaded.savedRequests : [];
    },
    /** Called only on a completed run (success — including non-2xx — never on send). */
    recordRun(entry: RestHistoryEntry) {
      if (!entry.endpoint.trim()) return;
      ctx.vscode.postMessage({ type: 'addRestCallHistory', ...entry });
    },
    onHistoryUpdated(list: RestHistoryEntry[]) {
      state.history.value = Array.isArray(list) ? list : [];
    },
    onSavedUpdated(list: SavedRestCall[]) {
      state.saved.value = Array.isArray(list) ? list : [];
    },
  };
}

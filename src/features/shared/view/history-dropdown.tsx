// THE history dropdown, shared by the SOQL tab's queries and the REST tab's
// requests: a "History ▾" button opening a panel with two sections — Saved
// (named, removable) and Recent (auto-recorded) — plus the "★ Save" row.
//
// Extracted at its SECOND consumer, the way every other shared webview
// primitive here was (category-filter-bar, tab-strip, headers-editor). The two
// copies were ~90% identical and already shared one set of `.query-history-*`
// styles; only the row payload differed. Deferring the extraction until the
// REST tab was Preact and the SOQL tab had a characterization suite is what
// kept it from being a seam designed against a single consumer.
//
// Modelled on `tab-strip.js`'s generic-core-plus-`ctx` split: this file never
// names a payload field, and reaches its consumer only through the ctx
// callbacks below.
//
// ── THE CORE POSTS NOTHING ────────────────────────────────────────────────────
// Load-bearing, and the reason `persistSaved` exists rather than a `vscode` +
// message name in the ctx. Each binding posts its own list under its own
// LITERAL message name, so the protocol union can still see every name. There
// is exactly one place in this codebase that posts a message type read from a
// variable (`tab-strip.js`'s `ctx.persistType`, documented there as the one
// name the union cannot check) and this extraction deliberately does not add a
// second.
//
// ── TWO RULES ─────────────────────────────────────────────────────────────────
// 1. ALL STATE LIVES IN THE FACTORY CLOSURE — never a module-scope `signal()`.
//    Two bundles import this file and each embeds its own Preact instance, so
//    module-scope state would be two registries pretending to be one.
// 2. THE ADMISSION TEST FOR A THIRD CONSUMER: it must need zero new ctx fields.
//    `overview/ask-ai/view/history.js` fails on four structural counts (a
//    single unnamed section, no save row, remove-by-id, a `refresh()` pull), so
//    it is deliberately NOT a consumer rather than generalized against
//    speculatively.
//
// LOAD-BEARING: `dropdownEl` is the mount CONTAINER. Preact owns its children,
// and its own `display` is written by the effect in the factory — so a parent
// that renders it must treat it as an uncontrolled leaf (no children, no
// `style` prop) or the diff will fight the effect.

import { render } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { signal, effect, type Signal } from '@preact/signals';

/** A payload plus the label it was saved under. */
export type Saved<P> = P & { name: string };
/** A payload plus, for a Saved row only, the label the opened tab adopts. */
export type Picked<P> = P & { name?: string };

/** The user-facing strings that genuinely differ between the two tabs. */
export interface HistoryDropdownCopy {
  /** e.g. 'Name this query…' */
  savePlaceholder: string;
  /** e.g. 'No saved queries.' */
  emptySaved: string;
  /** e.g. 'No recent queries.' */
  emptyRecent: string;
  /** e.g. 'Remove saved query' */
  removeTooltip: string;
}

export interface HistoryDropdownCtx<P> {
  /** "History ▾" toggle. */
  buttonEl: HTMLButtonElement;
  /** Mount CONTAINER — see the load-bearing note above. */
  dropdownEl: HTMLElement;
  /** "★ Save" the current payload. */
  saveBtn: HTMLButtonElement;

  /**
   * A Recent row's text BEFORE elision — the core collapses whitespace and
   * elides at 70. Named `textOf`, not `labelOf`, because it is only ever called
   * for Recent rows: returning a finished label would push the identical
   * collapse-and-elide into each binding and leave a third live copy of it. A
   * Saved row shows `item.name`, never elided.
   */
  textOf(item: P): string;
  tooltipOf(item: P): string;
  /** `null` renders no badge — SOQL's is conditional, REST's never is. */
  badgeOf(item: P): string | null;

  getCurrent(): P;
  /**
   * Nothing worth saving. The binding reuses this for its own recordRun guard,
   * so "empty" means one thing per tab rather than two.
   */
  isEmpty(payload: P): boolean;
  /**
   * Name to pre-fill the save input with — the active tab's own title, whether
   * auto-derived, hand-renamed or adopted from a saved entry. Pre-selected, so
   * typing still replaces it.
   */
  getDefaultName(): string;

  onPick(entry: Picked<P>): void;
  /**
   * The Saved list changed (a save or a removal). The binding posts it under
   * its own literal message name — see "THE CORE POSTS NOTHING" above.
   */
  persistSaved(list: Saved<P>[]): void;
  /**
   * A Save was confirmed, with the name it was saved under — lets the caller
   * relabel the tab that was just saved, so the box the user typed a name into
   * and the tab they are looking at never disagree.
   */
  onSaved(name: string): void;

  copy: HistoryDropdownCopy;
}

export interface HistoryDropdownApi {
  /** Non-array input (an absent key in a host reply) resolves to []. */
  setHistory(list: unknown): void;
  setSaved(list: unknown): void;
}

/** Row text is one line, capped — the tooltip carries the whole thing. */
const MAX_ROW_CHARS = 70;

function elide(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_ROW_CHARS ? oneLine.slice(0, MAX_ROW_CHARS) + '…' : oneLine;
}

/**
 * Tooltips come from a webview global (media/modules/tooltip.js), which sets a
 * `data-tooltip` attribute and an aria-label together. Applied through a ref
 * rather than as JSX attributes so there stays exactly one helper doing both.
 */
interface CockpitTooltips {
  __setTooltip: (el: Element, text: string) => void;
}
function useTooltip<T extends HTMLElement>(text: string) {
  const ref = useRef<T | null>(null);
  useLayoutEffect(() => {
    if (ref.current) (window as unknown as CockpitTooltips).__setTooltip(ref.current, text);
  }, [text]);
  return ref;
}

interface PanelState<P> {
  history: Signal<P[]>;
  saved: Signal<Saved<P>[]>;
  open: Signal<boolean>;
  showSaveRow: Signal<boolean>;
}

function SaveRow<P extends object>({
  ctx,
  state,
}: {
  ctx: HistoryDropdownCtx<P>;
  state: PanelState<P>;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  // The input is a genuine uncontrolled leaf: seeded once here, then owned by
  // the DOM. Deliberately NOT a `value` prop — the panel re-renders whenever
  // the host pushes an updated list, and a bound value would reset the box
  // mid-typing. That is a real bug both consumers have had.
  //
  // Focus AND select because the pre-filled tab name is a suggestion, so typing
  // over it has to be as cheap as accepting it. A layout effect, so the row is
  // in the DOM by the time this runs.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.value = (ctx.getDefaultName() ?? '').trim();
    el.focus();
    el.select();
  }, []);

  const commit = () => {
    const name = inputRef.current?.value.trim() ?? '';
    if (!name) return;
    const cur = ctx.getCurrent();
    if (ctx.isEmpty(cur)) return;
    // Re-saving under an existing name replaces that entry and moves it to the
    // top, rather than leaving two rows with one label.
    state.saved.value = [{ ...cur, name }, ...state.saved.value.filter((s) => s.name !== name)];
    ctx.persistSaved(state.saved.value);
    ctx.onSaved(name);
    state.showSaveRow.value = false;
  };

  return (
    <div class="query-history-save-row">
      <input
        ref={inputRef}
        type="text"
        class="query-history-save-input"
        placeholder={ctx.copy.savePlaceholder}
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

function Row<P extends object>({
  ctx,
  item,
  isSaved,
  onPick,
  onRemove,
}: {
  ctx: HistoryDropdownCtx<P>;
  item: P | Saved<P>;
  isSaved: boolean;
  onPick: (entry: Picked<P>) => void;
  onRemove: () => void;
}) {
  const name = (item as Saved<P>).name;
  const badge = ctx.badgeOf(item);
  const labelRef = useTooltip<HTMLSpanElement>(ctx.tooltipOf(item));
  const removeRef = useTooltip<HTMLButtonElement>(ctx.copy.removeTooltip);

  return (
    <div class="query-history-item">
      {/* The badge LEADS: the label is the only elastic part of the row, so a
          trailing badge lands at a different x-offset on every line. */}
      {badge !== null && <span class="query-history-badge">{badge}</span>}
      <span
        ref={labelRef}
        class="query-history-item-label"
        onClick={() => onPick({ ...item, name: isSaved ? name : undefined })}
      >
        {isSaved ? name : elide(ctx.textOf(item))}
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

function Section<P extends object>({
  ctx,
  title,
  items,
  isSaved,
  onPick,
  onRemove,
}: {
  ctx: HistoryDropdownCtx<P>;
  title: string;
  items: (P | Saved<P>)[];
  isSaved: boolean;
  onPick: (entry: Picked<P>) => void;
  onRemove: (item: P | Saved<P>) => void;
}) {
  return (
    <div class="query-history-section">
      <div class="query-history-section-title">{`${title} (${items.length})`}</div>
      {items.length === 0 ? (
        <div class="query-history-empty">
          {isSaved ? ctx.copy.emptySaved : ctx.copy.emptyRecent}
        </div>
      ) : (
        items.map((item, i) => (
          <Row
            key={i}
            ctx={ctx}
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

function HistoryPanel<P extends object>({
  ctx,
  state,
}: {
  ctx: HistoryDropdownCtx<P>;
  state: PanelState<P>;
}) {
  // Closed renders nothing at all: no stale rows sit in the DOM, and a pick can
  // never reach a hidden panel.
  if (!state.open.value) return null;

  const pick = (entry: Picked<P>) => {
    ctx.onPick(entry);
    state.open.value = false;
    state.showSaveRow.value = false;
  };
  const remove = (item: P | Saved<P>) => {
    state.saved.value = state.saved.value.filter((s) => s !== item);
    ctx.persistSaved(state.saved.value);
  };

  return (
    <>
      {state.showSaveRow.value && <SaveRow ctx={ctx} state={state} />}
      <Section
        ctx={ctx}
        title="Saved"
        items={state.saved.value}
        isSaved
        onPick={pick}
        onRemove={remove}
      />
      <Section
        ctx={ctx}
        title="Recent"
        items={state.history.value}
        isSaved={false}
        onPick={pick}
        onRemove={remove}
      />
    </>
  );
}

export function createHistoryDropdown<P extends object>(
  ctx: HistoryDropdownCtx<P>,
): HistoryDropdownApi {
  // Rule 1 above: the signals belong to this call, not to the module. They are
  // also plain `signal()`s rather than `useSignal` hooks because a binding's
  // host message handlers call setHistory/setSaved from outside any render,
  // where hook-scoped state is unreachable.
  const state: PanelState<P> = {
    history: signal<P[]>([]),
    saved: signal<Saved<P>[]>([]),
    open: signal(false),
    showSaveRow: signal(false),
  };

  const close = () => {
    state.open.value = false;
    state.showSaveRow.value = false;
  };

  render(<HistoryPanel ctx={ctx} state={state} />, ctx.dropdownEl);
  // The container's own visibility, derived rather than written at each call
  // site — which is what lets a parent render it as a leaf with no style prop.
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
    setHistory(list: unknown) {
      state.history.value = Array.isArray(list) ? (list as P[]) : [];
    },
    setSaved(list: unknown) {
      state.saved.value = Array.isArray(list) ? (list as Saved<P>[]) : [];
    },
  };
}

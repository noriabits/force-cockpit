// Response rendering for the REST tab: a colour-coded status badge, a collapsible
// response-headers list, and a pretty-printed JSON body with clickable Salesforce
// record-Id links.
//
// The public API is unchanged — `createResponseView(ctx)` still returns
// { showResponse, showError, hideResponse } — but the ctx shrank to the two
// containers plus `vscode`, because Preact now renders everything that used to be
// passed in as pre-existing elements.
//
// LOAD-BEARING — the ID LINKS ARE NODES, NOT MARKUP. The old version escaped the
// whole body and then regex-injected <a> tags into `innerHTML`, so escaping was
// the only thing standing between an untrusted response body and script
// injection. There is no `innerHTML` here at all: text runs are Text nodes, so
// the property is structural rather than something a future edit could undo.
//
// The tokenizer matches on the RAW text where the old regex matched on the
// ESCAPED text, and that is equivalent, not merely close:
//   1. `__escapeHtml` replaces `&` FIRST, so a `&quot;` in the escaped output can
//      only have come from a `"` in the raw text — the mapping is bijective.
//   2. Escaping never creates or extends an 18-char alphanumeric run: every
//      entity it emits contains `&` and `;`, and neither is in [a-zA-Z0-9].
//   3. A checksum miss must CONSUME its match without emitting a link, mirroring
//      String.replace's callback returning `match` — which is what keeps
//      `"<id>"<id>"` at exactly one link rather than two.
//
// LOAD-BEARING — `responseEl` and `errorEl` are containers whose own `display` is
// written imperatively here, so once a parent component renders them they must be
// uncontrolled leaves (no `style` prop) or the diff will fight these writes.

import { render, type ComponentChildren } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { signal, computed, type Signal } from '@preact/signals';
import { isSalesforceRecordId } from '../../utils/salesforce';
import {
  openContentInEditor,
  wireCopyToClipboardButton,
} from '../../features/shared/view/output-actions';

export interface RestResponseData {
  status: number;
  statusText?: string;
  headers: Record<string, string>;
  body: unknown;
  sessionRefreshed?: boolean;
}

export interface ResponseViewCtx {
  /** Outer response container (toggled show/hide) and the panel's mount point. */
  responseEl: HTMLElement;
  /** Error box — still imperative; it lives outside the response subtree. */
  errorEl: HTMLElement;
  vscode: { postMessage: (msg: unknown) => void };
}

const EMPTY_BODY = '(empty response)';

function statusSuffix(status: number): 'ok' | 'warn' | 'error' {
  if (status >= 200 && status < 300) return 'ok';
  if (status >= 500) return 'error';
  return 'warn';
}

/** JSON-parse a string body if we can, then pretty-print whatever we ended up with. */
function prettyPrint(body: unknown): string {
  let parsed: unknown = body;
  if (typeof body === 'string') {
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = body;
    }
  }
  try {
    return typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2);
  } catch {
    return String(parsed);
  }
}

/** Quoted 18-char alphanumeric runs — candidate record Ids, checksum-verified below. */
const QUOTED_ID = /"([a-zA-Z0-9]{18})"/g;

/**
 * The pretty-printed body as both plain text (what Copy and Open-in-editor
 * export, and what `textContent` will read back) and the node list to render,
 * with every checksum-valid quoted record Id turned into a link.
 */
/* Not exported: its behaviour is pinned through the rendered <pre> in
   rest-flow.test.tsx, which is the form that survives a future port. Exporting it
   only for a test would be an export with no other consumer — the shape `knip`
   exists to reject. */
function formatResponseBody(
  body: unknown,
  onOpenRecord: (recordId: string) => void,
): { text: string; nodes: ComponentChildren[] } {
  if (body === undefined || body === '') return { text: EMPTY_BODY, nodes: [EMPTY_BODY] };

  const text = prettyPrint(body);
  const nodes: ComponentChildren[] = [];
  let last = 0;
  QUOTED_ID.lastIndex = 0;
  for (let m = QUOTED_ID.exec(text); m !== null; m = QUOTED_ID.exec(text)) {
    const id = m[1];
    // Consume the match but emit nothing: `last` is not advanced, so the quoted
    // token falls into the next text slice verbatim. See rule 3 in the header.
    if (!isSalesforceRecordId(id)) continue;
    if (m.index > last) nodes.push(text.slice(last, m.index));
    nodes.push(
      '"',
      <a
        href="#"
        class="rest-response-id-link"
        data-record-id={id}
        onClick={(e: Event) => {
          e.preventDefault();
          onOpenRecord(id);
        }}
      >
        {id}
      </a>,
      '"',
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return { text, nodes };
}

function HeadersList({ headers }: { headers: Record<string, string> }) {
  const entries = Object.entries(headers || {});
  if (entries.length === 0) {
    return <div class="rest-response-headers-empty">No response headers.</div>;
  }
  return (
    <>
      {entries.map(([key, value]) => (
        <div key={key} class="rest-response-header-row">{`${key}: ${value}`}</div>
      ))}
    </>
  );
}

/**
 * Uncontrolled leaf: `copyTextWithFeedback` swaps this button's own textContent
 * for 1.5s, so the label must NOT be vdom-owned — an unrelated re-render inside
 * that window would restore it early and the timer would then write it again.
 */
function CopyButton({ getText }: { getText: () => string }) {
  const ref = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    const btn = ref.current;
    if (!btn) return;
    btn.textContent = 'Copy to clipboard';
    wireCopyToClipboardButton(btn, getText);
  }, []);
  return <button ref={ref} type="button" class="btn btn-ghost" />;
}

interface PanelState {
  response: Signal<RestResponseData | null>;
  headersOpen: Signal<boolean>;
}

function ResponsePanel({ state, ctx }: { state: PanelState; ctx: ResponseViewCtx }) {
  // One tokenizer run per response rather than one per render — the body reaches
  // megabytes, and this component re-renders whenever the headers list toggles.
  const formatted = computed(() =>
    formatResponseBody(state.response.value?.body, (recordId) =>
      ctx.vscode.postMessage({ type: 'openRecord', recordId }),
    ),
  );

  const data = state.response.value;
  if (!data) return null;
  const suffix = statusSuffix(data.status);
  // The refreshed-session note explains the extra latency of the transparent replay.
  const refreshed = data.sessionRefreshed ? ' · session refreshed' : '';

  return (
    <>
      <div class="query-results-toolbar">
        <span class={`results-meta rest-response-status rest-response-status--${suffix}`}>
          {`${data.status}${data.statusText ? ' ' + data.statusText : ''}${refreshed}`}
        </span>
        <span class="query-toolbar-spacer" />
        <button
          type="button"
          class="btn btn-ghost"
          onClick={() => {
            state.headersOpen.value = !state.headersOpen.value;
          }}
        >
          Headers ▾
        </button>
      </div>
      <div class="rest-response-headers" style={{ display: state.headersOpen.value ? '' : 'none' }}>
        <HeadersList headers={data.headers} />
      </div>
      <pre class={`rest-response-body rest-response-body--${suffix}`}>{formatted.value.nodes}</pre>
      <div class="feature-actions" style={{ marginTop: '6px' }}>
        <button
          type="button"
          class="btn btn-ghost"
          onClick={() => openContentInEditor(formatted.value.text, ctx.vscode)}
        >
          Open in editor
        </button>
        <CopyButton getText={() => formatted.value.text} />
      </div>
    </>
  );
}

export function createResponseView(ctx: ResponseViewCtx) {
  const state: PanelState = { response: signal(null), headersOpen: signal(false) };
  // The container carried `style="display: none"` in main.html; now that a
  // component renders it as an empty leaf, its starting state is set here.
  ctx.responseEl.style.display = 'none';
  render(<ResponsePanel state={state} ctx={ctx} />, ctx.responseEl);

  return {
    showResponse(data: RestResponseData) {
      ctx.errorEl.style.display = 'none';
      state.response.value = data;
      state.headersOpen.value = false;
      ctx.responseEl.style.display = '';
    },
    showError(message: string) {
      ctx.responseEl.style.display = 'none';
      ctx.errorEl.textContent = message;
      ctx.errorEl.style.display = '';
    },
    hideResponse() {
      ctx.responseEl.style.display = 'none';
      ctx.errorEl.style.display = 'none';
      // Clearing the signal is what the old version's class-removal did: nothing
      // stale is left behind the hidden box, and the node list is freed.
      state.response.value = null;
    },
  };
}

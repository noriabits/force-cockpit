// @ts-check
// The log viewer: limit summary, detected issues, category chips, text search
// and the three view modes (Log / Tree / Queries). Parsing happened on
// the host — this module only renders what it was given.
//
// TWO CONSUMERS: the Debug Logs tab and the ▶️ Apex tab. It finds its markup by
// id and RENDERS that markup itself: each consumer's view.html holds only an
// empty `<div id="{prefix}-viewer-body">` mount (between its own title/actions
// and, for Debug Logs, the AI panel), and `createLogViewer({ idPrefix })` fills
// it with `bodyHtml(prefix)` below — so there is one copy of the skeleton, not
// one per tab. The classes, and therefore the styles in this feature's
// view.css, are shared. Its strings live here rather than in a labels.js global
// for the same reason: the Apex bundle runs before the Debug Logs labels script
// in document order, so a borrowed global would not exist yet.
import { scrollAndHighlight } from '../../../shared/view/scroll-highlight';
import { EVENT_GROUP_LABELS, groupOf, isErrorEvent } from '../parsing/eventCategories';
import { filterLines, findMatches } from '../parsing/logFilter';
import { formatBytes, formatMs } from './format';
import { createExecutionTree } from './execution-tree';
import { createQueryPlanTable } from './query-plan-table';

/**
 * The viewer's body: summary → issues → view modes → chips → output panes →
 * load-more. Ids carry `prefix` (`dbg`, `apex`); `$()` below maps `dbg-…` to it.
 * @param {string} prefix
 */
function bodyHtml(prefix) {
  return `
  <div class="dbg-summary" id="${prefix}-summary"></div>
  <div class="dbg-issues" id="${prefix}-issues"></div>

  <div class="dbg-view-modes">
    <div class="dbg-seg" id="${prefix}-mode-seg">
      <button type="button" class="dbg-seg-btn active" data-mode="log">Log</button>
      <button type="button" class="dbg-seg-btn" data-mode="tree">Tree</button>
      <button type="button" class="dbg-seg-btn" data-mode="queries">Queries</button>
    </div>
    <input
      type="text"
      class="text-input dbg-filter-input"
      id="${prefix}-log-search"
      data-no-generic-filter
      spellcheck="false"
      placeholder="Search in log…"
    />
    <span class="query-match-count" id="${prefix}-search-count"></span>
    <button type="button" class="btn btn-ghost btn-icon" id="${prefix}-search-prev">▲</button>
    <button type="button" class="btn btn-ghost btn-icon" id="${prefix}-search-next">▼</button>
    <label class="dbg-check">
      <input type="checkbox" id="${prefix}-hide-noise" checked /> Hide noise
    </label>
  </div>
  <div class="dbg-chips" id="${prefix}-chips"></div>

  <pre class="dbg-log-output" id="${prefix}-log-output"></pre>
  <div class="dbg-tree" id="${prefix}-log-tree" style="display: none"></div>
  <div class="dbg-query-table-wrap" id="${prefix}-query-table-wrap" style="display: none"></div>
  <button
    type="button"
    class="btn btn-ghost dbg-load-more"
    id="${prefix}-load-more"
    style="display: none"
  >
    Load more lines
  </button>
`;
}

/** Lines rendered per chunk — a 200k-line log must not lock the webview. */
const CHUNK_SIZE = 5000;

const labels = {
  summarySoql: 'SOQL',
  summaryDml: 'DML',
  summaryRows: 'Query rows',
  summaryCallouts: 'Callouts',
  truncatedChip: '⚠ truncated',
  noIssues: 'No issues detected by the built-in rules.',
  loadMore: 'Load more lines',
  linesShown: (/** @type {number} */ shown, /** @type {number} */ total) =>
    `${shown} of ${total} lines`,
  partialLog: 'This log is too large to show in full — only its start and end are loaded.',
};

/**
 * @param {{
 *   escapeHtml: (s: string) => string,
 *   idPrefix?: string,
 * }} ctx
 */
export function createLogViewer(ctx) {
  const { escapeHtml } = ctx;
  const prefix = ctx.idPrefix ?? 'dbg';
  const mount = document.getElementById(`${prefix}-viewer-body`);
  if (mount) mount.innerHTML = bodyHtml(prefix);
  const $ = (/** @type {string} */ id) =>
    /** @type {HTMLElement} */ (document.getElementById(id.replace(/^dbg-/, prefix + '-')));

  const card = $('dbg-viewer-card');
  const titleEl = $('dbg-viewer-title');
  const metaEl = $('dbg-viewer-meta');
  const summaryEl = $('dbg-summary');
  const issuesEl = $('dbg-issues');
  const modeSeg = $('dbg-mode-seg');
  const chipsEl = $('dbg-chips');
  const outputEl = /** @type {HTMLPreElement} */ ($('dbg-log-output'));
  const treeEl = $('dbg-log-tree');
  const queryTableEl = $('dbg-query-table-wrap');
  const loadMoreBtn = /** @type {HTMLButtonElement} */ ($('dbg-load-more'));
  const searchInput = /** @type {HTMLInputElement} */ ($('dbg-log-search'));
  const searchCount = $('dbg-search-count');
  const hideNoise = /** @type {HTMLInputElement} */ ($('dbg-hide-noise'));
  const statusEl = $('dbg-viewer-status');
  const errorEl = $('dbg-viewer-error');

  /** @type {any} */ let opened = null;
  /** @type {any} */ let row = null;
  /** @type {string[]} */ let activeGroups = [];
  /** @type {'log'|'tree'|'queries'} */ let mode = 'log';
  /** @type {number[]} */ let matches = [];
  let matchCursor = 0;
  let rendered = 0;

  const tree = createExecutionTree({
    escapeHtml,
    onJumpToLine: (lineNo) => {
      setMode('log');
      jumpToLine(lineNo);
    },
  });
  const queryTable = createQueryPlanTable({
    escapeHtml,
    onJumpToLine: (lineNo) => {
      setMode('log');
      jumpToLine(lineNo);
    },
  });

  // ── Summary + issues ────────────────────────────────────────────────────

  function renderMeta() {
    if (!row) {
      metaEl.innerHTML = '';
      return;
    }
    const failed = row.status && row.status !== 'Success';
    metaEl.innerHTML =
      `<span class="dbg-meta-item"><strong>${escapeHtml(row.operation)}</strong></span>` +
      `<span class="dbg-meta-item dbg-status ${failed ? 'dbg-status--error' : 'dbg-status--ok'}">` +
      `${escapeHtml(row.status || '—')}</span>` +
      `<span class="dbg-meta-item">${escapeHtml(row.logUserName)}</span>` +
      `<span class="dbg-meta-item">${formatMs(row.durationMilliseconds)}</span>` +
      `<span class="dbg-meta-item">${formatBytes(row.logLength)}</span>` +
      `<span class="dbg-meta-item">${escapeHtml(row.request || '')}</span>`;
  }

  function renderSummary() {
    const summary = opened.summary;
    summaryEl.innerHTML = '';

    const counts = document.createElement('div');
    counts.className = 'dbg-summary-counts';
    const items = [
      [labels.summarySoql, summary.counts.soql],
      [labels.summaryDml, summary.counts.dml],
      [labels.summaryRows, summary.counts.rows],
      [labels.summaryCallouts, summary.counts.callouts],
      ['USER_DEBUG', summary.counts.userDebug],
    ];
    for (const [label, value] of items) {
      const chip = document.createElement('span');
      chip.className = 'dbg-count-chip';
      chip.innerHTML = `<span class="dbg-count-value">${value}</span> ${escapeHtml(String(label))}`;
      counts.appendChild(chip);
    }
    if (summary.truncated) {
      const chip = document.createElement('span');
      chip.className = 'dbg-count-chip dbg-count-chip--warn';
      chip.textContent = labels.truncatedChip;
      counts.appendChild(chip);
    }
    if (opened.partial) {
      const chip = document.createElement('span');
      chip.className = 'dbg-count-chip dbg-count-chip--warn';
      chip.textContent = labels.partialLog;
      counts.appendChild(chip);
    }
    summaryEl.appendChild(counts);

    const bars = document.createElement('div');
    bars.className = 'dbg-limit-bars';
    const limits = summary.limits
      .filter((/** @type {any} */ l) => l.percent !== null)
      .sort((/** @type {any} */ a, /** @type {any} */ b) => b.percent - a.percent)
      .slice(0, 8);
    for (const limit of limits) {
      const item = document.createElement('div');
      item.className = 'dbg-limit';
      const severity = limit.percent >= 90 ? 'critical' : limit.percent >= 70 ? 'warn' : 'ok';
      item.innerHTML =
        `<div class="dbg-limit-meta"><span>${escapeHtml(limit.name)}</span>` +
        `<span class="mono">${limit.used} / ${limit.max}</span></div>` +
        `<div class="dbg-limit-track"><div class="dbg-limit-fill dbg-limit-fill--${severity}" ` +
        `style="width:${Math.min(100, limit.percent)}%"></div></div>`;
      bars.appendChild(item);
    }
    if (limits.length) summaryEl.appendChild(bars);
  }

  function renderIssues() {
    issuesEl.innerHTML = '';
    if (!opened.issues.length) {
      issuesEl.innerHTML = `<div class="dbg-empty">${escapeHtml(labels.noIssues)}</div>`;
      return;
    }
    for (const issue of opened.issues) {
      const item = document.createElement('div');
      item.className = `dbg-issue dbg-issue--${issue.severity}`;
      const where =
        issue.lineNo === null ? '' : `<span class="dbg-issue-line">L${issue.lineNo}</span>`;
      item.innerHTML =
        `<div class="dbg-issue-head"><span class="dbg-issue-sev">${issue.severity}</span>` +
        `<strong>${escapeHtml(issue.title)}</strong>${where}</div>` +
        `<div class="dbg-issue-detail">${escapeHtml(issue.detail)}</div>` +
        (issue.evidence.length
          ? `<pre class="dbg-issue-evidence">${escapeHtml(issue.evidence.join('\n'))}</pre>`
          : '') +
        `<div class="dbg-issue-fix">→ ${escapeHtml(issue.suggestion)}</div>`;
      if (issue.lineNo !== null) {
        item.classList.add('dbg-issue--clickable');
        item.addEventListener('click', () => {
          setMode('log');
          jumpToLine(issue.lineNo);
        });
      }
      issuesEl.appendChild(item);
    }
  }

  // ── Chips + rendering ───────────────────────────────────────────────────

  function renderChips() {
    chipsEl.innerHTML = '';
    // "None": the whole log, nothing filtered. It is a state as much as a button —
    // lit while no category is selected AND Hide noise is off, and clicking it
    // clears both. (It took over from the old Raw view, which was exactly that.)
    const none = document.createElement('button');
    none.type = 'button';
    none.className = 'dbg-chip';
    none.classList.toggle('active', !activeGroups.length && !hideNoise.checked);
    none.textContent = 'None';
    none.addEventListener('click', () => {
      activeGroups = [];
      hideNoise.checked = false;
      renderChips();
      renderLines(true);
    });
    chipsEl.appendChild(none);
    for (const group of EVENT_GROUP_LABELS) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'dbg-chip';
      chip.classList.toggle('active', activeGroups.includes(group.id));
      chip.textContent = group.label;
      chip.addEventListener('click', () => {
        activeGroups = activeGroups.includes(group.id)
          ? activeGroups.filter((g) => g !== group.id)
          : [...activeGroups, group.id];
        renderChips();
        renderLines(true);
      });
      chipsEl.appendChild(chip);
    }
  }

  function visibleIndices() {
    return filterLines(opened.events, {
      groups: /** @type {any} */ (activeGroups),
      text: '',
      hideNoise: hideNoise.checked,
      keepContinuations: true,
    });
  }

  function lineHtml(/** @type {any} */ event) {
    const group = event.event ? groupOf(event.event) : 'other';
    const error = event.event && isErrorEvent(event);
    const classes = `dbg-line dbg-line--${group}${error ? ' dbg-line--error' : ''}`;
    return (
      `<span class="${classes}" data-line="${event.lineNo}">` +
      `<span class="dbg-line-no">${event.lineNo}</span>` +
      `<span class="dbg-line-text">${escapeHtml(event.raw)}</span></span>`
    );
  }

  function renderLines(/** @type {boolean} */ reset) {
    if (mode !== 'log') return;
    if (reset) {
      rendered = 0;
      outputEl.innerHTML = '';
    }
    const indices = visibleIndices();
    const slice = indices.slice(rendered, rendered + CHUNK_SIZE);
    outputEl.insertAdjacentHTML(
      'beforeend',
      slice.map((/** @type {number} */ i) => lineHtml(opened.events[i])).join(''),
    );
    rendered += slice.length;

    const remaining = indices.length - rendered;
    loadMoreBtn.style.display = remaining > 0 ? '' : 'none';
    loadMoreBtn.textContent = `${labels.loadMore} (${remaining})`;
    statusEl.textContent = labels.linesShown(indices.length, opened.totalLines);
  }

  /** Whether the Log view, as currently filtered, would render this line. */
  function isLineVisible(/** @type {number} */ lineNo) {
    return visibleIndices().some((i) => opened.events[i].lineNo === lineNo);
  }

  function jumpToLine(/** @type {number} */ lineNo) {
    // A jump from an issue, the tree, the query table or a search match must land
    // on its line. If a chip or Hide noise is filtering it out, drop every filter
    // (exactly what the None chip does) rather than scroll to nothing.
    if (!isLineVisible(lineNo)) {
      activeGroups = [];
      hideNoise.checked = false;
      renderChips();
      renderLines(true);
    }
    // The line may live past the rendered chunk — keep loading until it is in.
    let guard = 0;
    while (
      !outputEl.querySelector(`[data-line="${lineNo}"]`) &&
      loadMoreBtn.style.display !== 'none'
    ) {
      renderLines(false);
      if (++guard > 40) break;
    }
    scrollAndHighlight(outputEl, `[data-line="${lineNo}"]`, 'dbg-line--highlight', 1500);
  }

  function setMode(/** @type {'log'|'tree'|'queries'} */ next) {
    mode = next;
    modeSeg.querySelectorAll('.dbg-seg-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-mode') === next);
    });
    const isTree = next === 'tree';
    const isQueries = next === 'queries';
    treeEl.style.display = isTree ? '' : 'none';
    queryTableEl.style.display = isQueries ? '' : 'none';
    outputEl.style.display = isTree || isQueries ? 'none' : '';
    chipsEl.style.display = next === 'log' ? '' : 'none';
    loadMoreBtn.style.display = 'none';
    if (isTree) tree.render(treeEl, opened.tree);
    else if (isQueries) queryTable.render(queryTableEl, opened.queryPlans);
    else renderLines(true);
  }

  // ── Search ──────────────────────────────────────────────────────────────

  function runSearch() {
    matches = findMatches(opened?.events ?? [], searchInput.value);
    matchCursor = 0;
    searchCount.textContent = searchInput.value.trim()
      ? `${matches.length} match${matches.length === 1 ? '' : 'es'}`
      : '';
    if (matches.length) gotoMatch(0);
  }

  function gotoMatch(/** @type {number} */ index) {
    if (!matches.length) return;
    matchCursor = (index + matches.length) % matches.length;
    const event = opened.events[matches[matchCursor]];
    searchCount.textContent = `${matchCursor + 1} of ${matches.length}`;
    setMode('log');
    jumpToLine(event.lineNo);
  }

  // ── Wiring ──────────────────────────────────────────────────────────────

  modeSeg.addEventListener('click', (event) => {
    const next = /** @type {HTMLElement} */ (event.target).getAttribute('data-mode');
    if (next && opened) setMode(/** @type {any} */ (next));
  });
  hideNoise.addEventListener('change', () => {
    renderChips(); // "None" is only lit while nothing at all is filtering
    renderLines(true);
  });
  loadMoreBtn.addEventListener('click', () => renderLines(false));
  searchInput.addEventListener('input', () => {
    if (opened) runSearch();
  });
  $('dbg-search-prev').addEventListener('click', () => gotoMatch(matchCursor - 1));
  $('dbg-search-next').addEventListener('click', () => gotoMatch(matchCursor + 1));

  return {
    /**
     * @param {any} data  the `apexLogOpened` payload (or an Apex run's `log`)
     * @param {any} logRow the matching list row, for the metadata line; null for none
     * @param {{ title?: string, scroll?: boolean }} [options]
     *   `scroll: false` keeps the page where it is
     *   (a tab switch re-showing a stored log should not jump the view).
     */
    show(data, logRow, options = {}) {
      opened = data;
      row = logRow;
      activeGroups = [];
      matches = [];
      searchInput.value = '';
      searchCount.textContent = '';
      errorEl.style.display = 'none';
      card.style.display = '';
      titleEl.textContent = options.title ?? `🔍 ${logRow ? logRow.operation : 'Log'}`;
      renderMeta();
      renderSummary();
      renderIssues();
      renderChips();
      setMode('log');
      if (options.scroll !== false) card.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    },
    hide() {
      card.style.display = 'none';
      opened = null;
      row = null;
      outputEl.innerHTML = '';
      treeEl.innerHTML = '';
      queryTableEl.innerHTML = '';
    },
    isOpen: () => !!opened,
    getLogId: () => (opened ? opened.logId : ''),
    getRawText: () => opened?.events.map((/** @type {any} */ e) => e.raw).join('\n') ?? '',
    showError(/** @type {string} */ message) {
      errorEl.textContent = message;
      errorEl.style.display = '';
      card.style.display = '';
    },
  };
}

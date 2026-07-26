// @ts-check
// The log viewer: limit summary, detected issues, category chips, text search
// and the three view modes (Pretty / Tree / Raw). Parsing happened on the host —
// this module only renders what it was given.
import { scrollAndHighlight } from '../../../shared/view/scroll-highlight';
import { EVENT_GROUP_LABELS, groupOf, isErrorEvent } from '../parsing/eventCategories';
import { filterLines, findMatches } from '../parsing/logFilter';
import { formatBytes, formatMs } from './format';
import { createExecutionTree } from './execution-tree';
import { createQueryPlanTable } from './query-plan-table';

/** Lines rendered per chunk — a 200k-line log must not lock the webview. */
const CHUNK_SIZE = 5000;

/**
 * @param {{
 *   labels: any,
 *   vscode: { postMessage: (msg: any) => void },
 *   escapeHtml: (s: string) => string,
 * }} ctx
 */
export function createLogViewer(ctx) {
  const { labels, escapeHtml } = ctx;
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

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
  /** @type {'pretty'|'tree'|'queries'|'raw'} */ let mode = 'pretty';
  /** @type {number[]} */ let matches = [];
  let matchCursor = 0;
  let rendered = 0;

  const tree = createExecutionTree({
    escapeHtml,
    onJumpToLine: (lineNo) => {
      setMode('pretty');
      jumpToLine(lineNo);
    },
  });
  const queryTable = createQueryPlanTable({
    escapeHtml,
    onJumpToLine: (lineNo) => {
      setMode('pretty');
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
          setMode('pretty');
          jumpToLine(issue.lineNo);
        });
      }
      issuesEl.appendChild(item);
    }
  }

  // ── Chips + rendering ───────────────────────────────────────────────────

  function renderChips() {
    chipsEl.innerHTML = '';
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
    if (mode !== 'pretty' && mode !== 'raw') return;
    if (reset) {
      rendered = 0;
      outputEl.innerHTML = '';
    }
    const indices =
      mode === 'raw'
        ? opened.events.map((/** @type {any} */ _e, /** @type {number} */ i) => i)
        : visibleIndices();
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

  function jumpToLine(/** @type {number} */ lineNo) {
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

  function setMode(/** @type {'pretty'|'tree'|'queries'|'raw'} */ next) {
    mode = next;
    modeSeg.querySelectorAll('.dbg-seg-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-mode') === next);
    });
    const isTree = next === 'tree';
    const isQueries = next === 'queries';
    treeEl.style.display = isTree ? '' : 'none';
    queryTableEl.style.display = isQueries ? '' : 'none';
    outputEl.style.display = isTree || isQueries ? 'none' : '';
    chipsEl.style.display = next === 'pretty' ? '' : 'none';
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
    setMode('pretty');
    jumpToLine(event.lineNo);
  }

  // ── Wiring ──────────────────────────────────────────────────────────────

  modeSeg.addEventListener('click', (event) => {
    const next = /** @type {HTMLElement} */ (event.target).getAttribute('data-mode');
    if (next && opened) setMode(/** @type {any} */ (next));
  });
  hideNoise.addEventListener('change', () => renderLines(true));
  loadMoreBtn.addEventListener('click', () => renderLines(false));
  searchInput.addEventListener('input', () => {
    if (opened) runSearch();
  });
  $('dbg-search-prev').addEventListener('click', () => gotoMatch(matchCursor - 1));
  $('dbg-search-next').addEventListener('click', () => gotoMatch(matchCursor + 1));

  return {
    /**
     * @param {any} data  the `apexLogOpened` payload
     * @param {any} logRow the matching list row, for the metadata line
     */
    show(data, logRow) {
      opened = data;
      row = logRow;
      activeGroups = [];
      matches = [];
      searchInput.value = '';
      searchCount.textContent = '';
      errorEl.style.display = 'none';
      card.style.display = '';
      titleEl.textContent = `🔍 ${logRow ? logRow.operation : 'Log'}`;
      renderMeta();
      renderSummary();
      renderIssues();
      renderChips();
      setMode('pretty');
      card.scrollIntoView({ behavior: 'smooth', block: 'start' });
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

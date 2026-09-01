// Webview code. Loaded as an ES module with the panel's nonce, so you can split
// across relative imports if you want — but you cannot import from the
// extension's own source. Everything you need arrives on `window`.

const fc = window.__fcPlugin('apex-jobs');

const filterSelect = document.getElementById('apex-jobs-filter');
const refreshBtn = document.getElementById('apex-jobs-refresh');
const autoToggle = document.getElementById('apex-jobs-auto');
const errorBox = document.getElementById('apex-jobs-error');
const results = document.getElementById('apex-jobs-results');

const AUTO_REFRESH_MS = 10000;
let autoTimer = null;

function showError(message) {
  // `.error-box` relies on the global `:empty` rule, so clear it to hide it.
  errorBox.textContent = message ?? '';
  errorBox.style.display = message ? 'block' : 'none';
}

function relativeTime(iso) {
  if (!iso) return '';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

function statusBadge(status) {
  const badge = document.createElement('span');
  badge.className = `apex-jobs-badge apex-jobs-badge--${status.toLowerCase()}`;
  badge.textContent = status;
  return badge;
}

function progressText(job) {
  if (!job.total) return '';
  return `${job.processed}/${job.total}`;
}

function abortButton(job, onDone) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-ghost apex-jobs-abort';
  btn.textContent = '⏹';
  fc.setTooltip(btn, `Stop ${job.name}`);

  btn.addEventListener('click', async () => {
    showError(null);
    // No `button` passed to invoke here: __startAction would inject a
    // "✕ Cancel" beside this one, and "cancel the abort" reads as nonsense in a
    // table row. A plain disable is the honest affordance — and aborting is a
    // single Apex statement, so there is nothing worth cancelling.
    btn.disabled = true;
    try {
      await fc.invoke('abort', { jobId: job.id });
      await load();
    } catch (err) {
      // A declined production prompt and a ✕ Cancel both arrive as
      // 'Operation cancelled' — neither is a failure worth reporting.
      if (err.message !== 'Operation cancelled') showError(err.message);
      btn.disabled = false;
    }
    onDone?.();
  });

  return btn;
}

function render(jobs) {
  results.replaceChildren();

  if (!jobs.length) {
    const empty = document.createElement('p');
    empty.className = 'card-description';
    empty.textContent = 'No jobs match this filter.';
    results.appendChild(empty);
    return;
  }

  const table = document.createElement('table');
  table.className = 'apex-jobs-table';

  const head = table.insertRow();
  for (const label of ['Job', 'Type', 'Status', 'Progress', 'Errors', 'Submitted', '']) {
    const th = document.createElement('th');
    th.textContent = label;
    head.appendChild(th);
  }

  for (const job of jobs) {
    const tr = table.insertRow();

    // Build nodes, never innerHTML — org data is not yours to trust.
    const nameCell = tr.insertCell();
    const link = document.createElement('span');
    link.className = 'apex-jobs-link';
    link.textContent = job.name;
    link.addEventListener('click', () => fc.openRecord(job.id));
    fc.setTooltip(link, `Open ${job.id} in Salesforce`);
    nameCell.appendChild(link);

    tr.insertCell().textContent = job.jobType;
    tr.insertCell().appendChild(statusBadge(job.status));
    tr.insertCell().textContent = progressText(job);

    const errorCell = tr.insertCell();
    errorCell.textContent = job.errors ? String(job.errors) : '';
    if (job.errors) errorCell.className = 'apex-jobs-errors';
    // ExtendedStatus is where Salesforce puts the "first error" text.
    if (job.extendedStatus) fc.setTooltip(errorCell, job.extendedStatus);

    const whenCell = tr.insertCell();
    whenCell.textContent = relativeTime(job.createdDate);
    if (job.submittedBy) fc.setTooltip(whenCell, `Submitted by ${job.submittedBy}`);

    const actionCell = tr.insertCell();
    if (job.abortable) actionCell.appendChild(abortButton(job));
  }

  results.appendChild(table);
}

async function load(options = {}) {
  if (!fc.connected) {
    render([]);
    return showError('Not connected to any org.');
  }
  showError(null);
  try {
    // `button` buys the spinner, the ✕ Cancel and the busy accounting that
    // makes an org switch warn — right for a refresh the user asked for.
    // The auto-refresh below deliberately passes none, so a background poll
    // never disables the button or flashes a Cancel every ten seconds.
    const jobs = await fc.invoke('list', { filter: filterSelect.value }, options);
    render(jobs);
  } catch (err) {
    if (err.message !== 'Operation cancelled') showError(err.message);
  }
}

function stopAuto() {
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = null;
}

function syncAuto() {
  stopAuto();
  if (autoToggle.checked && fc.connected) {
    autoTimer = setInterval(() => void load(), AUTO_REFRESH_MS);
  }
}

refreshBtn.addEventListener('click', () => void load({ button: refreshBtn }));
filterSelect.addEventListener('change', () => void load({ button: refreshBtn }));
autoToggle.addEventListener('change', syncAuto);

fc.onOrg({
  onConnected: () => {
    showError(null);
    syncAuto();
    void load();
  },
  onDisconnected: () => {
    // Stop polling an org that is no longer there.
    stopAuto();
    render([]);
    showError('Not connected to any org.');
  },
});

if (fc.connected) void load();

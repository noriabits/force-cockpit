// Host-side logic. Runs in the Force Cockpit sandbox with the org connection
// already wired up — `query`, `executeApex`, `restCall`, `run`, `log`, `fs`,
// `path` and more are globals here (no imports, no npm).
//
// Assign each handler onto `exports`; the panel calls them by name through
// fc.invoke('<name>', args).
//
// This file is re-read on EVERY invoke, so editing it takes effect on your next
// click — no reload needed. (view.html / plugin.yaml changes do need
// "Force Cockpit: Reload Plugins".)

/**
 * Salesforce keeps a job in one of these states. "In flight" is the set worth
 * watching, and the only set `abortJob` will accept.
 */
const IN_FLIGHT = ['Holding', 'Queued', 'Preparing', 'Processing'];

/**
 * The panel sends a filter KEY, never a SOQL fragment, and this map is the only
 * thing that turns one into a WHERE clause. Anything unrecognised falls through
 * to no filter rather than reaching the query — the same "validate against a
 * known set" rule that keeps a record Id out of a string literal below.
 */
const FILTERS = {
  active: IN_FLIGHT,
  failed: ['Failed'],
  finished: ['Completed', 'Aborted'],
};

const JOB_FIELDS = `
  Id, Status, JobType, MethodName, ApexClass.Name, CreatedBy.Name,
  JobItemsProcessed, TotalJobItems, NumberOfErrors,
  ExtendedStatus, CreatedDate, CompletedDate
`;

exports.list = async ({ filter } = {}) => {
  const statuses = FILTERS[filter];
  const where = statuses ? `WHERE Status IN ('${statuses.join("', '")}')` : '';

  const result = await query(
    `SELECT ${JOB_FIELDS} FROM AsyncApexJob ${where} ORDER BY CreatedDate DESC LIMIT 50`,
  );

  log(`${result.records.length} job(s).`);

  return result.records.map((r) => ({
    id: r.Id,
    status: r.Status,
    jobType: r.JobType,
    // A batch job names its class; a future/queueable one only has a method.
    name: r.ApexClass?.Name ?? r.MethodName ?? r.JobType,
    submittedBy: r.CreatedBy?.Name ?? '',
    processed: r.JobItemsProcessed ?? 0,
    total: r.TotalJobItems ?? 0,
    errors: r.NumberOfErrors ?? 0,
    extendedStatus: r.ExtendedStatus ?? '',
    createdDate: r.CreatedDate,
    completedDate: r.CompletedDate,
    abortable: IN_FLIGHT.includes(r.Status),
  }));
};

/**
 * Stop a job.
 *
 * There is deliberately NO confirmation code here. Against a production org, or
 * a sandbox listed in `protectedSandboxes`, Force Cockpit raises the native
 * modal by itself the moment `executeApex` is reached, and throws
 * 'Operation cancelled' if the user declines. Do not add your own prompt on top.
 */
exports.abort = async ({ jobId }) => {
  // The id arrives from the webview and ends up inside an Apex string literal,
  // so it is validated against the shape of a real Salesforce Id and refused —
  // never escaped.
  if (!/^([a-zA-Z0-9]{15}|[a-zA-Z0-9]{18})$/.test(String(jobId ?? ''))) {
    throw new Error(`"${jobId}" is not a valid job Id.`);
  }

  log(`Aborting ${jobId}…`);
  const result = await executeApex(`System.abortJob('${jobId}');`);

  if (!result.success) {
    // A job that finished between the last refresh and this click is the common
    // case, and Salesforce says so clearly — pass its message straight through.
    throw new Error(result.compileProblem || result.exceptionMessage || 'Could not abort the job.');
  }

  log('Aborted.');
  return { aborted: jobId };
};

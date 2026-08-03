---
name: force-cockpit-yaml-scripts
description: Use when writing, editing, or debugging Force Cockpit YAML scripts (apex/command/js/ai) — covers the exact schema, required/optional fields, input variables and placeholders, the JS sandbox API, and the AI-script safety model. Trigger on requests to add/modify a script under force-cockpit/scripts/, or anything asking for a new Force Cockpit automation.
---

# Force Cockpit YAML Scripts

[Force Cockpit](https://marketplace.visualstudio.com/items?itemName=noriabits.force-cockpit) is a VS Code extension. Its **Scripts** tab runs automations defined as YAML files. Each file is **exactly one script** — there is no multi-step pipeline syntax, no `steps:` list. This skill is the authoritative schema for authoring those files by hand.

> Force Cockpit's separate **Monitoring** tab also loads YAML files (`force-cockpit/monitoring/*.yaml`), but those are chart/dashboard configs with a completely different, unrelated schema. This skill does not cover them — do not mix the two formats.

## Where files live

| Path | Committed to git? |
|---|---|
| `force-cockpit/scripts/{category}/*.yaml` | Yes — shared with the team |
| `force-cockpit/scripts/{category}/{sub-category}/*.yaml` | Yes — one level of sub-category nesting is supported for a second row of filter pills |
| `force-cockpit/private/scripts/{category}/*.yaml` | No — auto-added to `.gitignore`, personal-only |

- `{category}` (and optional `{sub-category}`) is just the directory name — pick whatever groups your scripts logically (e.g. `data-fixes`, `release`, `debug`). It becomes the folder/pill shown in the UI.
- The base `force-cockpit/` folder is resolved from the workspace root, unless the user has overridden it with the VS Code setting `forceCockpit.cockpitPath`.
- New/edited files are picked up automatically when the Scripts tab reloads — no rebuild or window reload needed.
- The filename doesn't have to match `name:` — pick any `kebab-case-name.yaml`.

## Anatomy of a script file

Every file needs:

1. `name:` — **required**. Display name on the script card.
2. `description:` — optional. Subtitle on the card.
3. **Exactly one** of these 8 fields, which determines the script's kind and its content:
   - `apex:` / `apex-file:`
   - `command:` / `command-file:`
   - `js:` / `js-file:`
   - `ai:` / `ai-file:`
4. `inputs:` — optional list of variables prompted for at execution time (see below).

Setting **zero** or **two or more** of the 8 script fields makes the script invalid — it still shows up in the UI, but as an error card with the exact validation message instead of an Execute button. Don't do this.

### The 4 kinds at a glance

| Kind | Inline field | File field | Org connection | Output |
|---|---|---|---|---|
| Apex | `apex:` | `apex-file:` | Required | Debug log |
| Command | `command:` | `command-file:` | Not used | stdout / stderr |
| JavaScript | `js:` | `js-file:` | Optional | Whatever `log()`/`console.log()` writes |
| AI | `ai:` | `ai-file:` | Required | Streamed model analysis |

### `*-file` variants

Instead of inlining code, point at a file already in the workspace:

```yaml
name: Nightly Cleanup
apex-file: scripts/apex/nightly-cleanup.apex
```

The path is workspace-relative. It must resolve **inside** the workspace root (no `../` escapes) and must exist — otherwise the script is marked invalid with a descriptive error, it does not crash anything.

## Inputs & placeholders

Declare variables that get prompted for before execution:

```yaml
inputs:
  - name: accountId          # required: identifier, used as ${accountId}
    label: Account ID        # optional: display label (defaults to name)
    required: true            # optional: Execute stays disabled until filled
  - name: status
    label: Status
    type: picklist            # optional: string (default) | picklist | checkbox | textarea
    options: [New, Active, Closed]   # picklist only
  - name: sendEmail
    label: Send notification email
    type: checkbox
    default: true              # checkbox only — pre-checked
  - name: notes
    label: Notes
    type: textarea              # multi-line text input
```

`type` field reference — these are the **only** four valid values, all optional (defaults to `string`):

| `type` | Extra fields | Renders as |
|---|---|---|
| `string` (default) | — | single-line text input |
| `picklist` | `options: [...]` | dropdown |
| `checkbox` | `default: true` (optional) | checkbox |
| `textarea` | — | multi-line text input |

Use `${name}` anywhere in the script body (and, for `ai` scripts, in `gather.soql:` / `gather.apex:` too) to substitute the value. Escaping is automatic and type-aware — **never hand-escape a placeholder yourself**:

| Script kind | Escaping applied to `${var}` |
|---|---|
| `apex` | Backslashes and `'` doubled, newlines turned into literal `\n` — safe to drop straight into an Apex string literal `'${var}'` |
| `js` | `JSON.stringify(value).slice(1, -1)` — safe inside a JS string literal `'${var}'` |
| `command` / `ai` | Raw, unescaped |

There's one built-in **system placeholder**, always available without declaring it in `inputs:`: `${orgUsername}` — the connected org's username (empty string if no org is connected). If you declare a user input with the same name, your input wins.

If any `required: true` input is left blank, execution is blocked before anything runs.

## Apex scripts

```yaml
name: Abort Tests
description: Aborts all in-progress and queued Apex test runs.
apex: |
  List<ApexTestQueueItem> testItems = [SELECT Status FROM ApexTestQueueItem WHERE Status != 'Completed'];
  for (ApexTestQueueItem atqi : testItems) {
      atqi.Status = 'Aborted';
  }
  update testItems;
```

- Runs as anonymous Apex against the connected org, at a **fixed, quiet log level** (`Apex Code: DEBUG`, `System: ERROR`, everything else `NONE`) — independent of whatever's configured in the Debug Logs tab. The log holds your `System.debug()` output plus any unhandled exception, nothing else.
- Two apex-only optional flags — both are just **log-viewer display defaults**, not execution behavior:
  - `filter-user-debug: true` — default the output view to USER_DEBUG lines only.
  - `format-json: true` — default the output view to pretty-printed JSON.

## Command scripts

```yaml
name: Run Unit Tests
description: Runs the local Jest suite.
command: npm test
```

A raw shell command executed in the workspace root. No org connection is made or required. Output is stdout+stderr combined.

## JavaScript scripts

```yaml
name: Bulk SObject Updater
inputs:
  - name: sobject
    label: sObject
    required: true
  - name: field
    label: Field
    required: true
  - name: newValue
    label: New value
    required: true
  - name: where
    label: WHERE condition
js: |-
  const sobject = '${sobject}';
  const field = '${field}';
  const newValue = '${newValue}';
  const where = `${where}`;

  if (!sobject || !field) {
    throw new Error('Missing required params: object, field');
  }

  const whereClause = where ? ` WHERE ${where}` : '';
  const soql = `SELECT Id FROM ${sobject}${whereClause}`;
  log('Updating records...');
  const results = await connection.query(soql).update({ [field]: newValue }, sobject);

  const failed = results.filter((r) => !r.success);
  log(`Done. ${results.length - failed.length} updated, ${failed.length} failed`);
  if (failed.length > 0) {
    error(JSON.stringify(failed, null, 2));
    throw new Error('One or more updates failed.');
  }
```

- Runs in a Node `vm` sandbox, wrapped as `(async () => { <your code> })()` — so top-level `await` works fine, and `return` inside your code just exits the wrapper (it does **not** become the output).
- **Nothing is auto-printed.** You must call `log(...)` or `console.log(...)` for anything to show up in the output.
- Available sandbox globals:

| Global | What it is |
|---|---|
| `connection` | jsforce `Connection`, or `null` if no org connected |
| `org` | Current org details, or `null` |
| `query(soql)` | Runs a SOQL query against the connected org |
| `executeApex(apexBody, options?)` | Runs anonymous Apex, returns the debug-log result |
| `log(...)` / `error(...)` | Write to the script's output |
| `console.log` / `console.error` / `console.warn` | Aliases of the above |
| `run(cmd)` | Runs a shell command, streaming its output into the log |
| `fs`, `os`, `path` | Node built-ins |
| `yaml` | `js-yaml` |
| `xmlFormat`, `DOMParser`, `XMLSerializer`, `xml`, `xmlEscape` | XML parsing/formatting helpers |
| `input.parseLines(text, fields)` | Splits `text` into `\n`-separated, `#`-comment-skipping, comma-delimited rows and maps each to `{ [fields[i]]: value }` — handy for pasted bulk data |
| `workspaceRoot` | Absolute path of the open workspace |
| `setTimeout`, `clearTimeout`, `Promise` | Standard async primitives |

## AI scripts

An AI script optionally runs a **fixed, author-written** data-gathering step, then sends the result plus a prompt to a language model (VS Code's Language Model API, via GitHub Copilot) for analysis. The model only ever reads and writes text back — it never executes anything that mutates data.

```yaml
name: Account Health Analysis
description: Summarises an account's open opportunities and recent cases, flags risks.
model: auto   # required — a model id from Copilot's picker, or "auto"
inputs:
  - name: accountId
    label: Account ID
    required: true
gather:                       # optional — omit entirely for a prompt-only script
  soql: >                     # exactly one of: soql / apex / apex-file
    SELECT Id, Name, Industry, AnnualRevenue,
           (SELECT Name, StageName, Amount, CloseDate FROM Opportunities WHERE IsClosed = false),
           (SELECT Subject, Status, Priority, CreatedDate FROM Cases ORDER BY CreatedDate DESC LIMIT 20)
    FROM Account
    WHERE Id = '${accountId}'
ai: |                          # the analysis prompt (or use ai-file: to load from a file)
  You are reviewing the health of a single Salesforce account.
  Using the gathered data below, summarise open pipeline, support signal,
  and give an overall health rating (Green/Amber/Red) with justification.
allow-followup-queries: true          # optional — model may run extra read-only SOQL
allow-read-workspace-files: true      # optional — model may search/read workspace source & metadata
skills:                               # optional — ids of other Agent Skills the model may read on demand
  - some-other-skill-id
```

Field reference:

| Field | Required | Notes |
|---|---|---|
| `model:` | Yes | A model id from Copilot's picker, or `auto` |
| `gather:` | No | Fixed data step, run by code — **never** authored or chosen by the model. If present, set **exactly one** of `soql:`, `apex:`, `apex-file:`. Its result is fenced and appended to the prompt as gathered data. |
| `ai:` / `ai-file:` | Yes (one of them) | The analysis prompt |
| `allow-followup-queries:` | No | `true` lets the model call a **read-only** SOQL tool (SELECT only, including Tooling API when it decides it needs metadata) for extra context |
| `allow-read-workspace-files:` | No | `true` lets the model search and read any non-gitignored workspace source/metadata file |
| `skills:` | No | List of other skill ids (same `.claude/skills/{id}/SKILL.md` / `.github/skills/{id}/SKILL.md` convention as this file) the model may pull in full on demand |

Safety model: **you** write the `gather` query/Apex and it runs exactly as written — the model never writes or picks Apex/SOQL for the gather step, so gathering can never modify data. The model's only additional capability, if you opt in, is more **read-only** SOQL and file reads. There is no tool exposed that writes anything.

## Common mistakes to avoid

- Setting two script fields at once (e.g. both `apex:` and `js:`) — the script becomes invalid with an "ambiguous" error.
- Setting no script field at all — "missing required field" error.
- On an `ai` script's `gather:`, setting zero or 2+ of `soql`/`apex`/`apex-file`.
- Pointing a `*-file` field outside the workspace root, or at a file that doesn't exist.
- Writing a `js` script that never calls `log()`/`console.log()` — it will run "successfully" with empty output.
- Using `type: picklist` without an `options:` list.
- Hand-escaping a `${placeholder}` — don't; escaping is automatic and type-aware, and double-escaping will corrupt the value.
- Forgetting quotes around a `${var}` placeholder inside Apex/JS string literals — e.g. `'${accountId}'`, not bare `${accountId}`.

## Quick reference: where to save a new script

Shared, committed: `force-cockpit/scripts/{category}/{your-script}.yaml`
Personal, git-ignored: `force-cockpit/private/scripts/{category}/{your-script}.yaml`

Pick a `{category}` that groups it sensibly with existing scripts in the workspace (check what folders already exist under `force-cockpit/scripts/` before inventing a new one).

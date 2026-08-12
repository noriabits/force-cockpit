---
name: force-cockpit-yaml-scripts
description: Use when writing, editing, or debugging Force Cockpit YAML scripts (apex/command/js/ai) — covers the exact schema, required/optional fields, input variables and placeholders, the JS sandbox API, and the AI-script safety model. Trigger on requests to add/modify a script under force-cockpit/scripts/, or anything asking for a new Force Cockpit automation.
---

# Force Cockpit YAML Scripts

[Force Cockpit](https://marketplace.visualstudio.com/items?itemName=noriabits.force-cockpit) is a VS Code extension. Its **Scripts** tab runs automations defined as YAML files. Each file is **exactly one script** — there is no multi-step pipeline syntax, no `steps:` list. A script can hand off to others once its own body finishes, via `then:` or `runScript()` (see [Composing scripts](#composing-scripts)). This skill is the authoritative schema for authoring those files by hand.

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
5. `then:` — optional list of scripts to run afterwards, each optionally guarded by a `when:` (see [Composing scripts](#composing-scripts)).

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
| `assertApexSuccess(result)` | Throws with the compile problem, or the exception message and stack trace, if an `executeApex` result failed. Otherwise does nothing |
| `filterUserDebugLines(log)` | Reduces a debug log to just your `System.debug` output — strips the `\|USER_DEBUG\|` prefixes and keeps multiline continuations. Same filter the apex-script `filter-user-debug` flag uses |
| `apexValue(value)` | Renders a JS value as an Apex literal — quoted and escaped strings, bare numbers/booleans, objects and arrays as quoted JSON, empty/missing as `null`. Use it for every value you interpolate into Apex you build yourself; it supplies the quotes, so write `Id x = ${apexValue(id)};`, not `'${apexValue(id)}'` |
| `log(...)` / `error(...)` | Write to the script's output |
| `console.log` / `console.error` / `console.warn` | Aliases of the above |
| `run(cmd)` | Runs a shell command, streaming its output into the log |
| `runScript(id, inputs?, options?)` | Runs **another script** by id and resolves with its result — see [Composing scripts](#composing-scripts) |
| `setOutput(name, value)` | Exposes a value to whoever called *this* script via `runScript` |
| `fs`, `os`, `path` | Node built-ins |
| `yaml` | `js-yaml` |
| `xmlFormat`, `DOMParser`, `XMLSerializer`, `xml`, `xmlEscape` | XML parsing/formatting helpers |
| `input.parseLines(text, fields)` | Splits `text` into `\n`-separated, `#`-comment-skipping, comma-delimited rows and maps each to `{ [fields[i]]: value }` — handy for pasted bulk data |
| `workspaceRoot` | Absolute path of the open workspace |
| `setTimeout`, `clearTimeout`, `Promise` | Standard async primitives |

## Composing scripts

There are two ways to reuse one script from another. Pick by whether you need conditionals and loops:

| | `then:` | `runScript()` |
|---|---|---|
| Works on | **any** kind (`apex`, `command`, `js`, `ai`) | `js` bodies only |
| Shape | declarative list in the YAML | imperative calls in JS |
| Logic | steps in order, each guarded by an optional `when:` expression | full JS control flow |
| Reading a result | **no** — the caller cannot see what a step produced | yes — `result.outputs` |
| Use when | a script should simply hand off when it's done | you need `if`/loops/`try`, or a value mid-flight |

Both share the same value-passing protocol (below), the same cycle/depth guards, and both stream the callee's output into the caller's log under a `── ▶ {id} ──` header.

### `then:` — declarative follow-ups

Any script can list scripts to run after its own body succeeds. This lets an `apex` script keep all its Apex *and* chain onward — no orchestrator wrapper needed.

```yaml
name: 🛖 Create Account Hierarchy
inputs:
  - name: accountName
    required: true
  - name: cartType
    type: picklist
    options: [None, Quote, Order]
apex-file: force-cockpit/scripts/testData/accHierarchy.apex
then:
  - script: testData/create-enterprise-cart
    when: ${cartType} !== "None" # ← skip the step entirely for None
    with:
      accountId: ${contractantAccId} # ← an ::fc-output of the Apex above
      cartType: ${cartType} # ← this script's own input
      namePrefix: ${accountName}
```

- `script` (required) — the callee's id, `{category}/{filename-without-extension}`.
- `with` (optional) — values for the callee's declared inputs. `${...}` resolves against **this script's outputs first**, then its inputs, then `${orgUsername}`. Values are passed as raw data; the callee escapes them for its own type. **Nothing is inherited**: a callee sees only what `with:` gives it, so a value needed three scripts down must be forwarded at every hop.
- `when` (optional) — skip the step unless the condition holds (below).
- Steps run **in order**, and only if the body succeeded. The first failing step fails the whole run and skips the rest.
- The Scripts form has **no editor** for `then:` — author it in the YAML (**📄 Open YAML**). Saving from the form preserves it.

#### `when:` conditions

A `when:` is a **JavaScript expression**. Placeholders are substituted as literals, then it is evaluated in an empty sandbox and the result taken as a boolean.

```yaml
when: ${cartType} !== "None" # skip the step for None
when: ${cartType} === "Quote" && ${status} === "Active" # both must hold
when: !${skipCart} || ${force} # negation and ||
when: ${name}.startsWith("TEST-") # any string method
when: ${cartId} # only if the body published one
```

The whole language is available — `&&`, `||`, `!`, parentheses, ternaries, `.includes()`, `Number(...)`. There is no bespoke grammar to learn.

**Quote your comparands.** Placeholders become literals, so a bare word is an undefined identifier: `${cartType} !== None` fails, `${cartType} !== "None"` works. This is caught when the script loads, not when it runs.

| Value | Substituted as | So a bare `${x}` is |
| --- | --- | --- |
| a checkbox (`true` / `false`) | a real boolean | true when ticked |
| anything else | a quoted string | true unless empty |
| nothing published | `""` | false |

Checkbox values become real booleans so `when: ${flag}` reads naturally — otherwise the string `"false"` would be truthy. Everything else is a string, so **`"0"` is truthy** (a non-empty string) and `${count} > 5` compares numerically only because the *other* side is a number literal. For a numeric compare between two placeholders, wrap them: `Number(${a}) > Number(${b})`.

**Values can never inject code.** They are substituted as JSON literals, so a name containing `"; drop()` arrives as an ordinary string. The sandbox has no host globals — no `require`, no `process` — and a 100 ms timeout.

Errors surface as early as possible:

- **When the script loads** — a syntax error, or an unquoted comparand. The script shows as an invalid card before it can run.
- **When the step is reached** — anything that depends on the real value, e.g. `${a}.deeper.still`. The chain fails with `Could not evaluate 'when: …'`.

Two YAML-level gotchas, neither of them Force Cockpit rules:

- **Quote the whole expression if it starts with `!` or a quote.** `when: !${skip}` is invalid YAML (`!` is YAML's tag indicator); write `when: "!${skip}"`. Same for a leading `'` or `"`.
- **`#` starts a comment.** `when: ${x} === "a" # why` is fine — the comment is stripped — but a `#` inside a comparand needs that operand quoted, which it already is.

**Both outcomes are logged, with the substituted expression next to the original**, so a guard that fires the wrong way shows its own reason:

```
── ✔ testData/create-enterprise-cart (when: ${cartType} !== "None" → "Quote" !== "None") ──
── ⏭ testData/create-enterprise-cart skipped (when: ${cartType} !== "None" → "None" !== "None") ──
```

That second half is the useful part. `→ "" !== "None"` means the value never reached the condition — the placeholder resolved to empty and the guard passed for the wrong reason, which reads exactly like "the condition was ignored".

### `runScript()` — imperative calls from JS

A `js` script can call any other script — of **any** kind — with `runScript()`, which is what you want when the chain needs real logic.

```
runScript(id, inputs?, options?) → Promise<{
  success, message, debugLog, filteredDebugLog?, outputs, cancelled?
}>
```

- `id` is the callee's script id — `{category}/{filename-without-extension}`, e.g. `testData/create-enterprise-cart`.
- `inputs` maps to the callee's declared `inputs:`. A called script only substitutes `${vars}` it **declares** in its own YAML, exactly as when run from the UI, and its `required: true` inputs are still enforced.
- It **rejects if the called script fails.** Pass `{ throwOnError: false }` to get the failed result back instead.

Worked example — a loop, a value read back, and per-item error handling, none of which `then:` can express:

```yaml
name: 🔁 Bulk Create Contacts
inputs:
  - name: accountId
    required: true
  - name: lastNames
    type: textarea
    required: true
js: |
  const accountId = "${accountId}";
  const names = input
    .parseLines("${lastNames}", ['lastName'])
    .map((row) => row.lastName)
    .filter(Boolean);

  const created = [];
  const failed = [];

  for (const lastName of names) {
    // Hands the failure back instead of aborting the loop, so one bad row
    // does not lose the rest.
    const result = await runScript(
      'examples/create-contact-for-account',
      { accountId, lastName },
      { throwOnError: false },
    );

    if (result.success) created.push(result.outputs.contactId);
    else failed.push(lastName + ': ' + result.message);
  }

  log('Created ' + created.length + ' of ' + names.length);
  if (failed.length > 0) {
    error(failed.join('\n'));
    throw new Error(failed.length + ' contact(s) could not be created.');
  }
```

…where the called script ends with `System.debug('::fc-output contactId=' + c.Id);` so `result.outputs.contactId` has something to read. Ships as **Bulk Create Contacts (runScript)** under `examples/`.

### Passing values back

Every call — `then:` step or `runScript()` — is a **separate transaction** (a separate anonymous-Apex execution), so a script cannot hand a variable to the next one directly. It publishes named values instead, which the caller reads from `result.outputs` (in JS) or interpolates as `${name}` (in a `then:` step's `with`).

Each kind has **exactly one** way to publish, and it does not vary by what the caller is — any kind can hand a value to any other kind:

| Kind | How it publishes | Example |
|---|---|---|
| `apex` | a `::fc-output` line in the debug log | `System.debug('::fc-output accountId=' + acc.Id);` |
| `command` | a `::fc-output` line on stdout | `echo "::fc-output buildId=$BUILD_ID"` |
| `js` | `setOutput(name, value)` — **not** a printed line | `setOutput('target', 'staging');` |
| `ai` | a `::fc-output` line in the model's output | (unreliable — the model must be told to emit it) |

```yaml
# command → apex
name: Build and record
command: npm run build   # prints ::fc-output buildId=B-42
then:
  - script: ops/record-build
    with: { buildId: '${buildId}' }
```

```yaml
# js → command
name: Pick environment
js: |
  const target = (await query('SELECT Name FROM Org__c LIMIT 1')).records[0].Name;
  setOutput('target', target);
then:
  - script: ops/deploy
    with: { env: '${target}' }
```

Rules that apply to every combination:

- **Values are always strings.** A marker's value is the rest of the line, so it may itself contain `=`.
- **Escaping is the callee's job**, and it happens automatically for the callee's kind — an Apex callee gets `''`-doubled quotes, a JS callee gets JSON escaping. Pass raw values; never pre-escape.
- **This covers placeholders only, not Apex you generate yourself.** A `js` script's inputs are escaped for JS; if that script then builds an Apex string and runs it via `executeApex`, those values are plain JS strings again and nothing has escaped them for Apex. Wrap each one in `apexValue(...)`.
- **A name nothing published resolves to empty**, not to the literal text `${name}`. If the callee declares it `required: true`, you get a clear "Required input … is missing" instead of `${name}` reaching your org.
- A `js` script's outputs come **only** from its own `setOutput` calls — it never inherits the outputs of scripts it called. To pass a callee's value further up, re-export it: `setOutput('accountId', r.outputs.accountId)`.

> **The one trap.** In a `js` script, `log('::fc-output foo=bar')` does **nothing** — the marker protocol is not read from a JS script's log, because that log also contains the logs of everything it called, and scraping it would silently adopt a callee's outputs as its own. Use `setOutput()`.

> **Command scripts take values unescaped**, because a shell has no safe universal quoting. A chained value containing `;` or `&&` is interpreted by the shell, so don't feed unvalidated org data straight into a `command:` step.

#### Values flow forwards only

`with:` interpolates the **caller's** outputs into the step it is starting. There is no path back: a caller can never read what its `then:` step produced. Only `runScript()` returns a result to its caller.

So publishing outputs from the *last* script in a `then:` chain is dead code — nothing can read them:

```yaml
# ops/finalise is the last step; its ::fc-output lines are pointless
then:
  - script: ops/finalise # publishes ::fc-output receiptId=… → nobody reads it
```

Add a marker when something actually consumes it, and remove it when nothing does. If you need a value back, use `runScript()`.

### Worked example

An `apex` script that creates records and hands the new account straight to another script — the Apex stays where it was, and one `then:` block replaces what used to be a copy-pasted block of cart-building Apex:

```apex
// accHierarchy.apex — ends by publishing what it created
insert contractantAcc;
System.debug('::fc-output contractantAccId=' + contractantAcc.Id);
```

```yaml
# create-account-hierarchy.yaml
name: 🛖 Create Account Hierarchy
inputs:
  - name: accountName
    required: true
  - name: cartType
    type: picklist
    options: [None, Quote, Order]
  - name: createMembers
    type: checkbox
apex-file: force-cockpit/scripts/testData/accHierarchy.apex
then:
  - script: testData/create-enterprise-cart
    when: ${cartType} !== "None"
    with:
      accountId: ${contractantAccId}
      cartType: ${cartType}
      createMembers: ${createMembers}
      namePrefix: ${accountName}
```


### Rules and limits

Both mechanisms share these:

- **Chains nest.** A script reached by `then:` runs its own `then:` too, and ordering is **depth-first**: for a root with steps `x` and `y`, where `x` itself chains to `x1`, the order is `root → x → x1 → y`. `x1` runs *before* `y`.
- **Cycles are rejected** — `a → b → a` fails with `Circular script call: …`.
- **Depth is capped at 10** nested calls.
- **Cancelling the run cancels the whole chain** — the abort signal is shared.
- Each callee's output is streamed into the caller's log under a `── ▶ {id} ──` header, so one accordion shows the whole run.
- A callee only substitutes `${vars}` it **declares** in its own `inputs:`, exactly as when run from the UI, and its `required: true` inputs are still enforced.
- The **sensitive-org confirmation prompt appears once**, for the script the user clicked — callees do not re-prompt. Keep that in mind when a chain drives destructive Apex.
- A `js` script's Execute button is enabled with no org connected (Force Cockpit cannot know statically that a callee needs one); an `apex` callee then fails with the usual not-connected error.

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
- Expecting a chained call to substitute an input the callee never declared in its own `inputs:` — declare it there first.
- Expecting a `js` orchestrator's `outputs` to include what its callees produced — re-export with `setOutput` instead.
- Leaving a comparand unquoted in a `when:` — `!== None` is an undefined identifier; write `!== "None"`.
- Using `type: picklist` without an `options:` list.
- Hand-escaping a `${placeholder}` — don't; escaping is automatic and type-aware, and double-escaping will corrupt the value.
- Forgetting quotes around a `${var}` placeholder inside Apex/JS string literals — e.g. `'${accountId}'`, not bare `${accountId}`.

## Quick reference: where to save a new script

Shared, committed: `force-cockpit/scripts/{category}/{your-script}.yaml`
Personal, git-ignored: `force-cockpit/private/scripts/{category}/{your-script}.yaml`

Pick a `{category}` that groups it sensibly with existing scripts in the workspace (check what folders already exist under `force-cockpit/scripts/` before inventing a new one).

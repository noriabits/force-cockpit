---
name: force-cockpit-plugins
description: Use when writing, editing, or debugging a Force Cockpit plugin — a user-authored panel under force-cockpit/plugins/ with its own HTML/CSS/JS and host-side handlers that reach the Salesforce org. Covers the two-realm split, plugin.yaml, the handlers.js globals and require, the window.__fcPlugin webview API, the CSP rules for view.html, and the automatic production-org gate. Trigger on requests to add or modify anything under force-cockpit/plugins/, or to build a custom Force Cockpit tab/panel/screen.
---

# Force Cockpit Plugins

[Force Cockpit](https://marketplace.visualstudio.com/items?itemName=noriabits.force-cockpit) is a VS Code extension. A **plugin** is a folder the user drops into their workspace that becomes a sub-tab of the extension's **Plugins** tab, with its own markup, styles and JavaScript — and the Salesforce org connection already wired up. No build step, no bundler, no `npm install`, nothing to publish.

> Force Cockpit's **Scripts** tab also runs user-authored code, but from YAML files with a completely different schema (`force-cockpit/scripts/*.yaml`) and no UI of your own. If the user wants a one-shot automation with a button and a log, that is a script — see the `force-cockpit-yaml-scripts` skill. Build a plugin when they want a *screen*: their own layout, their own controls, results rendered their way.

## Where files live

| Path                                          | Committed to git?                                            |
| --------------------------------------------- | ------------------------------------------------------------ |
| `force-cockpit/plugins/{plugin-id}/`          | Yes — shared with the team                                   |
| `force-cockpit/private/plugins/{plugin-id}/`  | No — `private/` is auto-added to `.gitignore`, personal-only |

- **The folder name is the plugin id.** One level deep only — `plugins/orders/` is a plugin, `plugins/team/orders/` is not.
- A private plugin **shadows** a shared one with the same folder name.
- The base `force-cockpit/` folder is the workspace root's, unless the user overrode it with the VS Code setting `forceCockpit.cockpitPath`.
- Never write outside the plugin's own folder.

```
force-cockpit/plugins/apex-jobs/
  plugin.yaml    # REQUIRED — the manifest
  view.html      # REQUIRED — your markup
  view.js        # your webview code
  view.css       # your styles
  handlers.js    # your Salesforce logic
  lib/           # optional helper files, loaded with require()
```

Only `plugin.yaml` and `view.html` are required. A folder with **no `plugin.yaml` is not a plugin** and is ignored silently. A folder *with* one that fails validation still appears as a sub-tab, showing the error instead of your UI — so a broken plugin is visible, never missing.

## The two realms — read this before writing any code

This is the single thing to get right. `view.js` and `handlers.js` run in **different processes** and share no scope. You cannot call one from the other directly.

```
┌─ Extension host (Node) ──────┐        ┌─ Webview (browser sandbox) ─┐
│  handlers.js                 │        │  view.js                    │
│    query, executeApex        │        │    document, DOM events     │
│    restCall, run, fs, os     │        │    your HTML + CSS          │
│    the org's access token    │        │                             │
│    ✗ NO document / DOM       │        │    ✗ NO fs, no Node         │
│                              │        │    ✗ NO network of any kind │
└──────────────┬───────────────┘        └──────────────┬──────────────┘
               │                                       │
               └──────── postMessage (JSON only) ──────┘
                          this is fc.invoke()
```

Consequences that will bite if ignored:

- **Never put `document`, `window` or DOM code in `handlers.js`.** It has no DOM.
- **Never put `query`, `executeApex` or `fs` in `view.js`.** It has no org access and no Node. The webview's Content-Security-Policy is `default-src 'none'` with no `connect-src`, so even `fetch` is blocked — `view.js` genuinely cannot reach Salesforce except through `fc.invoke`.
- **Only JSON-serializable values cross.** Arguments and return values go through structured clone: no functions, no class instances, no DOM nodes, no `Date` methods surviving as methods. Return plain objects and arrays.
- **Reshape data in `handlers.js`, not `view.js`.** Return exactly the fields the UI renders. Do not ship a whole jsforce record with its `attributes` noise across the boundary.

## `plugin.yaml`

```yaml
name: Apex Jobs # REQUIRED — the sub-tab label
description: Watch batch Apex, and stop one that has gone wrong. # sub-tab tooltip
icon: '⚙️' # optional emoji, prefixed to the label
```

`name` is the only required key. Missing or blank `name`, malformed YAML, or a missing `view.html` each turn the plugin into an error card.

## `handlers.js` — your Salesforce logic

Runs in the extension host. Assign each handler onto `exports`; the panel calls them by name.

```js
exports.list = async ({ filter }) => {
  const result = await query(`SELECT Id, Status FROM AsyncApexJob ${whereFor(filter)} LIMIT 50`);
  log(`${result.records.length} job(s).`); // streams to the panel live
  return result.records.map((r) => ({ id: r.Id, status: r.Status }));
};
```

- Handlers are `async` and receive one argument: whatever `view.js` passed as `args`.
- The return value is sent to `view.js`. Return plain JSON-able data.
- Anything you `throw` arrives in `view.js` as a rejected promise carrying your message. Throw with a message a user can act on.
- `module.exports = { … }` works too.

### Globals — no imports needed

| Global                                        | What it does                                                          |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| `query(soql)`                                 | Run SOQL. Resolves `{ records, totalSize, done }`                      |
| `executeApex(apex)`                           | Run anonymous Apex. Resolves `{ success, compileProblem, exceptionMessage, debugLog }` |
| `restCall(method, endpoint, body?, headers?)` | Any REST / Apex REST endpoint. Resolves `{ status, statusText, headers, body }` — a non-2xx is a normal result, not a throw |
| `connection`                                  | The raw jsforce `Connection` (escape hatch — see the gate warning below) |
| `org`                                         | The connected org: `{ username, orgId, instanceUrl, alias?, isSandbox?, accessToken }` |
| `run(cmd)`                                    | A shell command in the workspace root                                  |
| `log(...)`, `error(...)`, `console`           | Stream output to the panel while the handler runs                      |
| `require(path)`                               | Your own helper files — see below                                      |
| `fs`, `os`, `path`, `yaml`                    | Node modules                                                           |
| `apexValue(v)`                                | Render a JS value as a safe Apex literal (quotes and escapes strings)  |
| `xml`, `DOMParser`, `XMLSerializer`, `xmlFormat`, `xmlEscape` | XML helpers                                            |
| `args`, `pluginId`, `pluginDir`, `workspaceRoot` | The call's arguments, and where you are                             |

There is **no `fetch`** and **no `process`**.

### Splitting across files with `require`

One file is right for a small plugin, but handlers are cheap to add and each drags in guards and formatting. When `handlers.js` gets long, split it:

```js
// handlers.js — the handlers, and little else
const { listJobs } = require('./lib/jobs.js');
const { assertJobId } = require('./lib/validate.js');

exports.list = async ({ filter }) => listJobs(filter);
```

```js
// lib/jobs.js — the sandbox globals are here too, nothing to pass down
exports.listJobs = async (filter) => {
  const r = await query(`SELECT Id, Status FROM AsyncApexJob LIMIT 50`);
  log(`${r.records.length} job(s).`);
  return r.records;
};
```

It is CommonJS `require` with plugin-shaped limits:

- **Your own files only.** Relative paths inside the plugin folder; `../` out of it is refused.
- `require('fs')`, `require('os')`, `require('path')` and `require('js-yaml')` return the same objects as the globals. **npm packages are not available.**
- `./lib/jobs`, `./lib/jobs.js` and `./lib/` (an `index.js`) all resolve, as in Node.
- Cached per click; circular requires behave as Node's do.

### Editing and reload

**`handlers.js` and anything it `require`s are re-read on every handler call**, so edits take effect on the next click with no reload. Changes to `plugin.yaml`, `view.html`, `view.js` or `view.css` need **Force Cockpit: Reload Plugins** from the command palette.

## `view.js` — your panel

Loaded as an ES module, so it can `import` sibling files. Reach the host through `window.__fcPlugin`:

```js
const fc = window.__fcPlugin('apex-jobs'); // must match the folder name

refreshBtn.addEventListener('click', async () => {
  try {
    const jobs = await fc.invoke('list', { filter: 'active' }, { button: refreshBtn });
    render(jobs);
  } catch (err) {
    if (err.message !== 'Operation cancelled') showError(err.message);
  }
});
```

| Member                                          | What it does                                                       |
| ------------------------------------------------ | -------------------------------------------------------------------- |
| `invoke(handler, args, options?)`               | Call a handler. Resolves with its return value, rejects with its error |
| `connected`                                     | `true` when an org is connected                                      |
| `org`                                           | The connected org, or `null`                                         |
| `onOrg({ onConnected, onDisconnected })`        | React to the org changing                                            |
| `openRecord(id)`                                | Open a Salesforce record in the browser                              |
| `confirm(prompt)`                               | Native "are you sure" modal. Resolves `true`/`false`                 |
| `escapeHtml(s)`, `setTooltip(el, text)`         | Shared helpers                                                       |

### `invoke` options

- **`{ button: someButton }`** — disables the button, shows a spinner, injects a **✕ Cancel**, and counts the call as busy work so switching orgs mid-run warns the user. Use it for an action the user just clicked.
- **No `button`** — silent, in both senses: nothing is disabled, and the call is not counted as work in flight, so switching orgs mid-poll does not stop to ask about a request the user never made. Use it for a background poll.
- **`{ onChunk: (text) => … }`** — receives whatever the handler `log()`s, live, while it runs.

### Cancellation

A ✕ Cancel **and** a declined production prompt both reject with exactly `'Operation cancelled'`. Neither is a failure — do not render them as errors:

```js
catch (err) {
  if (err.message !== 'Operation cancelled') showError(err.message);
}
```

## `view.html` — your markup

A **fragment**, injected into your sub-tab's panel. Not a document.

- No `<html>`, `<head>` or `<body>`.
- **No inline `<script>`**, and no `onclick=` attributes — the panel's CSP blocks both. All behaviour goes in `view.js`, attached with `addEventListener`.
- **Prefix every `id` with your plugin id** (`id="apex-jobs-refresh"`). Ids are shared with the entire panel, and a collision silently breaks another tab.
- Inline `style="…"` attributes work.
- Images must be files in your plugin folder. `data:` URIs are blocked.

Reuse the extension's own classes so the plugin looks native. These are global and safe to use:

| Purpose  | Classes                                                          |
| --------- | ----------------------------------------------------------------- |
| Layout   | `card`, `card-header`, `card-title`, `card-description`, `card-actions`, `card-inner` |
| Buttons  | `btn` plus one of `btn-primary`, `btn-ghost`, `btn-icon`, `btn-sm` |
| Forms    | `text-input`, `form-label`, `feature-actions`                    |
| Feedback | `error-box`, `success-box`, `badge`, `empty-state`               |
| Tables   | `table-wrapper`, `results-table`                                 |

Anything else you see in the extension's own tabs (`.query-*`, `.rest-*`, `.yaml-*`, `.monitoring-*`) belongs to a feature's own stylesheet — do not rely on it. Write your own class in `view.css` instead.

```html
<section class="card">
  <h2 class="card-title">Apex Jobs</h2>
  <p class="card-description">Batch and queueable Apex on the connected org.</p>

  <div class="feature-actions">
    <button class="btn btn-primary" id="apex-jobs-refresh" type="button">Refresh</button>
  </div>

  <div class="error-box" id="apex-jobs-error" style="display: none"></div>
  <div id="apex-jobs-results"></div>
</section>
```

> `.error-box` relies on a global `:empty` rule. Clear its `textContent` to hide it — do not leave whitespace inside.

## `view.css` — your styles

Optional, and only for what the shared classes do not cover. **Always use the VS Code CSS variables** so the plugin follows the user's theme — never hardcode a colour:

`--vscode-foreground`, `--vscode-descriptionForeground`, `--vscode-panel-border`, `--vscode-textLink-foreground`, `--vscode-errorForeground`, `--vscode-charts-blue|green|yellow|red`.

Scope every selector to your own ids/classes; the stylesheet is loaded into the whole panel.

## The production-org gate — do not write your own

**Force Cockpit confirms destructive work for you.** On a production org, or a sandbox listed in `protectedSandboxes`, a native modal appears by itself the moment a handler reaches:

- `executeApex(...)` — always
- `restCall(...)` with `POST`, `PUT`, `PATCH` or `DELETE`
- `run(...)` — always

Reads (`query`, a `GET` `restCall`) never prompt. Confirming once covers the rest of that handler call, so a loop of a hundred updates asks once. Declining throws `'Operation cancelled'`.

So write the handler plainly:

```js
exports.abort = async ({ jobId }) => {
  assertJobId(jobId);
  await executeApex(`System.abortJob('${jobId}');`); // ← modal fires here on production
  return { aborted: jobId };
};
```

- **Do not** add your own confirmation around these calls — the user gets two prompts.
- `fc.confirm()` in `view.js` is for your own UX questions ("discard these edits?"), not for org safety.
- **The gate does not cover the raw `connection` object.** `connection.sobject('Account').update(...)` bypasses it entirely. Prefer `executeApex` / `restCall` for anything that writes; reach for `connection` only when neither can do the job, and say so in a comment.

## Security rules

The org's data and the user's input are both untrusted. These are not optional.

1. **Validate any identifier before it reaches SOQL or Apex — refuse, never escape.**

   ```js
   if (!/^[A-Za-z0-9_]+$/.test(objectName)) throw new Error(`Invalid object "${objectName}".`);
   if (!/^([a-zA-Z0-9]{15}|[a-zA-Z0-9]{18})$/.test(recordId)) throw new Error('Invalid record Id.');
   ```

   For string *values* rather than identifiers, use `apexValue(v)` to build the literal.

2. **Send keys from the panel, not query fragments.** The webview should send `'active'` and the handler should look it up in a fixed map. Never let `view.js` send SOQL, a WHERE clause, or a field list.

3. **Look those keys up in a `Map`, not an object literal.** This one is easy to
   get wrong and the failure is invisible in testing: on an object literal,
   `LOOKUP['__proto__']` returns `Object.prototype` and `LOOKUP['constructor']`
   returns `Object` — both **truthy** — so an unknown key sails past a
   `if (found)` check and then throws something unrelated further down.
   `toString`, `valueOf` and `hasOwnProperty` behave the same way. A `Map` has no
   prototype chain, so a key you did not put in it is simply `undefined`.

   ```js
   // ✓ unknown key → undefined, whatever it is called
   const FILTERS = new Map([
     ['active', ['Queued', 'Processing']],
     ['failed', ['Failed']],
   ]);
   const statuses = FILTERS.get(filter);

   // ✗ FILTERS['__proto__'] is truthy and is not an array
   const FILTERS = { active: ['Queued', 'Processing'], failed: ['Failed'] };
   const statuses = FILTERS[filter];
   ```

   The same applies to any lookup keyed by something the panel sent. If you must
   use an object literal, guard it with
   `Object.prototype.hasOwnProperty.call(obj, key)`.

4. **Build DOM nodes, never `innerHTML`, for anything from the org.** A record name can contain markup.

   ```js
   const cell = row.insertCell();
   cell.textContent = job.name; // ✓
   // cell.innerHTML = job.name; ✗ never
   ```

5. **Never log or return the session token.** `org.accessToken` must not cross into the webview.

## Common mistakes to avoid

- Calling `query()` or `executeApex()` in `view.js` — they do not exist there. Everything org-facing goes in `handlers.js`.
- Touching `document` in `handlers.js` — there is no DOM in the extension host.
- Returning a jsforce record straight from a handler — reshape it to the fields the UI needs.
- Returning a function, a class instance or a `Map` — only JSON-cloneable values cross.
- Passing `{ button }` to a background poll — it disables the control and flashes a ✕ Cancel every tick.
- Rendering `'Operation cancelled'` as an error — it is a cancel or a declined prompt, not a failure.
- Adding your own confirm around `executeApex` — the gate already does it, so the user sees two modals.
- Looking a panel-supplied key up in an object literal — `LOOKUP['__proto__']` and `LOOKUP['constructor']` are truthy and are not your data. Use a `Map`.
- Un-prefixed ids in `view.html` (`id="results"`) — they collide with the rest of the panel.
- Inline `<script>` or `onclick=` in `view.html` — silently blocked by the CSP; nothing runs and nothing warns.
- Hardcoded colours in `view.css` — unreadable in the other theme. Use the `--vscode-*` variables.
- `require('lodash')` or any npm package — unavailable. Only your own files and `fs`/`os`/`path`/`js-yaml`.
- `require('../../elsewhere.js')` — refused; a plugin can only require inside its own folder.
- Passing a plugin id to `window.__fcPlugin(...)` that does not match the folder name — every call will fail.
- Expecting a `view.html` or `plugin.yaml` edit to appear on save — those need **Force Cockpit: Reload Plugins**. Only `handlers.js` is live.
- Leaving a plugin with no `view.html` — it renders as an error card, not a panel.

## Checklist for a new plugin

1. Folder: `force-cockpit/plugins/{kebab-case-id}/` (or `private/plugins/…` if personal). Check what already exists there before inventing a name.
2. `plugin.yaml` with at least `name:`.
3. `view.html` — a fragment, ids prefixed with the plugin id, shared classes for styling, an `.error-box` and a results container.
4. `handlers.js` — one `exports.x` per action; validate every identifier; reshape rows before returning; `log()` progress.
5. `view.js` — `window.__fcPlugin('{plugin-id}')`, `{ button }` on user-clicked actions, `textContent` not `innerHTML`, swallow `'Operation cancelled'`, handle `fc.connected === false`, and wire `fc.onOrg` so an org switch resets the panel.
6. `view.css` only if needed, all `--vscode-*` colours, all selectors scoped.
7. Tell the user to run **Force Cockpit: Reload Plugins** to see it.

A complete worked example lives at `force-cockpit/plugins/apex-jobs/` in the Force Cockpit repository — read it before writing a new plugin from scratch.

# Force Cockpit — Claude Instructions

## What is this project?

A VSCode extension that provides a Salesforce utilities cockpit. It connects to Salesforce orgs via the SF CLI and offers operational tools for monitoring and general utilities — all from within VSCode.

Published on the VS Code Marketplace under the `noriabits` publisher. Also available as a `.vsix` file for manual installation.

## Architecture

```
src/
├── extension.ts                  # Entry point: commands, .sf/config.json file watcher
├── features/                     # Self-contained feature modules (one folder per feature)
│   ├── FeatureModule.ts          # Shared interface: FeatureModule, FeatureModuleFactory
│   ├── defineFeature.ts          # Factory helper: derives asset paths, wires service + routes
│   ├── apexUtils.ts              # assertApexSuccess() — shared Apex result validation
│   ├── registry.ts               # Feature registry — add ONE line here per new feature
│   ├── shared/
│   │   └── view/                 # Shared webview ES modules (imported by feature view bundles; never copied to dist — `view/` dirs are skipped by copy-feature-assets)
│   │       ├── category-filter-state.ts  # Pure filter state core (visibility/folder/sub-folder) — no DOM, unit-tested
│   │       └── category-filter-bar.js    # createCategoryFilterBar(...) — DOM layer: visibility buttons + category pills + sub-pills
│   ├── utils/
│   │   └── clone-user/
│   │       ├── index.ts          # FeatureModuleFactory: routes, paths
│   │       ├── CloneUserService.ts  # Business logic (no vscode imports)
│   │       ├── view.html         # Accordion HTML fragment (injected by MainPanel)
│   │       ├── view.js           # Webview JS (calls window.__registerFeature)
│   │       └── view.css          # Feature-specific styles
├── panels/
│   ├── MainPanel.ts              # Webview lifecycle + composition (connects the three below)
│   ├── WebviewAssets.ts          # HTML template + feature asset collection + webview module injection
│   ├── MessageRouter.ts          # Routes incoming webview messages (built-in + feature routes)
│   └── OperationRegistry.ts      # Terminal abort controllers + webview op mirror (hasActive, cancelAll)
├── salesforce/
│   ├── connection.ts             # jsforce wrapper (query, executeAnonymous, sandbox detection)
│   └── soap/                     # SOAP transport for executeAnonymousWithDebugLog
│       ├── SoapEnvelope.ts       # buildExecuteAnonymousEnvelope(apexBody, sessionId, logLevels)
│       ├── SoapClient.ts         # postSoapRequest(instanceUrl, apiVersion, envelope) — HTTPS transport
│       └── SoapResponseParser.ts # parseExecuteAnonymousResponse + extractXmlValue
├── services/                     # Shared/core services (not feature-specific)
│   ├── QueryService.ts           # SOQL query execution (used by Overview tab)
│   └── OrgConnectionController.ts # .sf/config.json → org-connection state machine (version-guarded connects, debounce, retry); no vscode import — deps injected
├── ui/
│   └── orgTypeStatusBar.ts       # setupOrgTypeStatusBar(...) — status-bar Production/Protected Sandbox/Sandbox indicator glue
└── utils/
    ├── config.ts                 # loadConfig() — YAML-based config loader with merge (bundled defaults ← user overrides)
    ├── sfCli.ts                  # Credential reading via @salesforce/core StateAggregator; openOrgInBrowser via SF CLI
    ├── orgType.ts                # resolveOrgType(connectionManager, protectedSandboxes) — pure production/protected/sandbox classifier
    ├── workspaceSetup.ts         # ensureUserFolders(userBasePath) — scaffolds scripts/monitoring/private folders + private/.gitignore
    ├── salesforceUrl.ts          # buildOrgUrl(org), buildRecordUrl(org, recordId) — shared URL builders for SF frontdoor.jsp
    ├── slug.ts                   # toSlug(name, fallback) — shared kebab-case slug generator (yaml-scripts + monitoring)
    ├── yaml-loader.ts            # loadYamlItems() — 3-way merge (builtin < user < private) of `{category}/{sub-category}/*.yaml`
    └── terminalCommand.ts        # Shared runTerminalCommand(command, workspaceRoot?) utility
```

### Configuration (`src/utils/config.ts`)

Extension settings are managed via YAML config files, not VSCode's `settings.json` (except `cockpitPath`).

**`CockpitConfig` interface**: `apiVersion`, `protectedSandboxes`, `panelTitle`, `logoPath`.

**Merge order**: hardcoded defaults → bundled `config.yaml` (at extension root, included in VSIX) → user `{userBasePath}/config.yaml`. Only keys present in a layer override the previous layer.

**`cockpitPath`** remains a VSCode setting (`forceCockpit.cockpitPath`) because it determines where the user config.yaml lives.

**`apiVersion`** (`string`, default `"65.0"`) — Salesforce API version for all API calls. Passed to `ConnectionManager.setApiVersion()` at activation. Used in jsforce `Connection` constructor and REST endpoint paths.

**Config is loaded at activation** and passed to `MainPanel` and `ConnectionManager`. A file watcher on `{userBasePath}/config.yaml` reloads config live — changes to `protectedSandboxes`, `panelTitle`, `logoPath`, and `apiVersion` take effect without reloading the window. `MainPanel.updateConfig()` re-applies the panel title and re-sends org info (so the protected-sandbox banner updates immediately).

### Webview (HTML/CSS/JS, runs in browser sandbox)
- `webviews/main.html` — Main panel HTML with tab layout and `<!-- features:{tab} -->` placeholders. Also holds a `${webviewModules}` placeholder injected by MainPanel.
- `media/main.js` — Thin bootstrap (~30 lines): attaches the top-level `message` listener that routes via `win.__dispatchMessage` → falls through to feature handlers. Posts `{type:'ready'}`.
- `media/modules/*.js` — Core webview modules, each a self-contained IIFE. Load synchronously in the order declared in `MainPanel.WEBVIEW_MODULES` (ipc.js first, so every other module can call `win.__onMessage(type, handler)` to subscribe). They must finish before `main.js` runs, which in turn runs before any feature `view.js` (feature scripts are `defer`):
  - `ipc.js` — core IPC primitives: `win.__vscode`, `win.__escapeHtml`, `win.__registerFeature`, `win.__featureHandlers`, `win.__onMessage(type, handler)`, `win.__dispatchMessage(msg)`. Must load first.
  - `action-tracker.js` — `win.__startAction` / `win.__endAction`, cancelled-ops set, `win.__isOpCancelled` / `win.__clearCancelledOp`, handler for `cancelAllOperations`. No-ops for `operationStarted`/`operationEnded` (used on the host side only).
  - `confirmation.js` — `win.__confirmIfSensitive` + `confirmActionResult` handler.
  - `org-lifecycle.js` — `orgConnecting` / `orgConnected` / `orgDisconnected` handlers. Renders status dot, org info card, sensitive-org banner, broadcasts to `win.__featureHandlers[*].onOrgConnected/onOrgDisconnected`. Sets `win.__orgConnected` and `win.__currentOrg` globals for other modules. Also wires the Open-in-Browser button + `openInBrowserDone` handler.
  - `storage-bars.js` — `storageLimits` handler → renders Data/File storage bars.
  - `query-editor.js` — SOQL Quick Query: textarea + Run/Clear + Cmd/Ctrl+Enter shortcut + results table. Handles `queryResult` / `queryError`. Exposes `win.__clearQueryResults` for org-lifecycle to call on disconnect.
  - `tabs.js` — top-level tab switching (Overview / Utils / Monitoring) + filter reset on tab leave.
  - `utils-subtab.js` — Utils sub-tab switching (Scripts / Built-in / Logs) + combined text + category filter for the Built-in sub-tab.
  - `accordion.js` — generic `.accordion-trigger` click → toggles `.accordion.open`.
  - `filter.js` — generic `.feature-filter-input` substring filter (skipped when `data-no-generic-filter` is present).
  - `paste-buttons.js` — delegated click handler for `.paste-btn`.
- `media/main.css` — Shared styles using VSCode CSS variables for theme compatibility
- `src/features/{tab}/{feature}/view.js` — Feature-specific webview JS (self-registering IIFE)
- `src/features/{tab}/{feature}/view.css` — Feature-specific styles

**Module dispatch pattern:** Rather than one big switch statement, each module subscribes to the message types it cares about via `win.__onMessage('someType', handler)`. The bootstrap in `main.js` calls `win.__dispatchMessage(msg)` — if any module handled the type, fallthrough stops; otherwise the message is broadcast to all feature `onMessage` handlers (this is how feature messages reach their `view.js`).

### Feature Module System

Each feature is a self-contained folder under `src/features/{tab}/{feature-id}/`. The feature folder contains everything: TypeScript, HTML, JS, and CSS.

**Build pipeline**: `npm run build` runs `scripts/copy-feature-assets.js` first, which copies all non-TS files from `src/features/` → `dist/features/` (skipping any `view/` subfolders — those are ES module sources bundled separately by esbuild). esbuild then runs three times: once for the extension TypeScript (`src/extension.ts` → `dist/extension.js`), once for the yaml-scripts webview (`src/features/utils/yaml-scripts/view/index.js` → `dist/features/utils/yaml-scripts/view.js`, IIFE format), and once for the monitoring-dashboard webview (`src/features/monitoring/monitoring-dashboard/view/index.js` → `dist/features/monitoring/monitoring-dashboard/view.js`, IIFE format). Both webview bundles can `import` from shared TS utilities under `src/utils/` (e.g. `salesforce.ts`) — esbuild resolves `.ts` extensions automatically. The VSIX packages `dist/features/` alongside `dist/extension.js`.

**`MainPanel.ts`** — Panel lifecycle and composition only (~200 lines). No business logic, no HTML generation, no message routing. It:
- Creates/reveals the webview panel (singleton pattern)
- Instantiates three collaborators: `WebviewAssets` (HTML), `MessageRouter` (incoming messages), `OperationRegistry` (in-flight ops)
- Wires the `onDidReceiveMessage` listener to `MessageRouter.handle()`
- Listens for `connectionChanged` and forwards org info / disconnect events to the webview
- Sends org info + storage limits via `_sendOrgInfo` (called on `ready`, visibility change, config reload, and reconnect)

**`WebviewAssets.ts`** — Builds the webview HTML. Reads `webviews/main.html`, collects feature HTML/CSS/JS fragments, injects the core module `<script>` tags (see `WebviewAssets.WEBVIEW_MODULES` for the load order) via the `${webviewModules}` placeholder, and performs all `${...}` token substitutions.

**`MessageRouter.ts`** — Dispatches incoming messages. Built-in host routes (`ready`, `query`, `openRecord`, `openExternalUrl`, `openInBrowser`, `confirmAction`, `operationStarted/Ended`, `cancelOperation`) are handled inline. Any other type falls through to feature routes registered via `defineFeature()`. The private `_route(action, successType, errorType, context)` helper echoes `opId` (and anything else in `context`) into both success and error responses so the webview can correlate.

**`OperationRegistry.ts`** — Tracks in-progress ops so the panel can guard org switches and cancel terminal commands mid-flight. Exposes `createTerminalAbort(opId)`, `cancelTerminalOp(opId)`, `endTerminalOp(opId)`, `startWebviewOp(opId)`, `endWebviewOp(opId?)`, `cancelAll()`, and the `hasActive` getter used by `guardBusy` in `extension.ts`.

**`src/features/defineFeature.ts`** — `defineFeature<S>({ id, tab, Service, routes })` helper. Automatically derives all asset paths (`htmlPath`, `jsPath`, `cssPath`, `labelsPath`) from `id` + `tab`, instantiates the service, and returns a `FeatureModuleFactory`. Every feature's `index.ts` should use this instead of manually constructing paths.

**`src/features/apexUtils.ts`** — Shared Apex utilities:
- `assertApexSuccess(result)` — Validates the result of `connectionManager.executeAnonymous()` or `executeAnonymousWithDebugLog()`. Throws on compilation or execution errors. All services that call Apex execution methods must use this instead of inline if/throw blocks.

**`src/features/{tab}/{id}/index.ts`** — Uses `defineFeature()` to declare the feature. Only specifies what's unique: `id`, `tab`, `Service` class, and `routes` (message type → handler + successType + errorType).

**`src/features/{tab}/{id}/labels.js`** — (Optional but recommended) Sets a global object (e.g. `window.MyFeatureLabels`) containing all user-facing strings: button text, placeholders, error and status messages. Loaded with `defer` before `view.js` so the global is ready. No `@ts-check`. Use `win = /** @type {any} */ (window)` pattern in `view.js` to access it without TypeScript errors.

**`src/features/{tab}/{id}/view.js`** — Webview IIFE. Casts `window` to `any` as `win` to access `win.__vscode`, `win.CloneUserLabels`, `win.__registerFeature`, and `win.__escapeHtml`. Calls `win.__registerFeature(id, { onOrgConnected, onOrgDisconnected, onMessage })` to receive org events and messages. Must NOT call `acquireVsCodeApi()`. Uses `// @ts-check` with JSDoc annotations for type safety. For HTML escaping, use `win.__escapeHtml(str)` — the shared global defined in `media/main.js`. Do NOT define local `escapeHtml` functions in feature scripts.

**`src/services/`** — Core/shared services only (not feature-specific). Feature-specific services live inside their feature folder.

**`ConnectionManager`** — Low-level Salesforce API wrapper. Services call it for `query()`, `executeAnonymous()`, `executeAnonymousWithDebugLog()`, `toolingQuery()`, `toolingRequest()`, `getSandboxName()`, etc.
- `isConnected: boolean` — true when a live connection exists
- `isConnecting: boolean` — true while a `connect()` call is in progress (prevents duplicate attempts)
- `connectingTarget: string | null` — alias/username of the org currently being connected; used to detect and reject duplicate connection attempts
- `_connectVersion` — internal monotonic counter incremented on every `connect()` and `disconnect()` call. After `conn.identity()` resolves, the in-flight `connect()` compares its captured version to the current one; if they differ (a `disconnect()` or newer `connect()` ran meanwhile), the result is discarded silently. `disconnect()` also clears `_connectingTarget` so a stale `finally` block can't clobber a newer call's target.
- `setApiVersion(version: string)` — sets the Salesforce API version used for jsforce connections and REST calls. Called once at activation from the loaded `CockpitConfig`.

**Apex Execution Methods:**
- `executeAnonymous(apexBody)` — Executes anonymous Apex via the Tooling API REST endpoint. Returns execution result (compiled, success, errors) but does NOT return debug logs. Use this for operations that don't need to capture `System.debug()` output.
- `executeAnonymousWithDebugLog(apexBody, options)` — Executes anonymous Apex via SOAP API with `DebuggingHeader`. Returns both execution result AND debug log in a single call. Does NOT require debug logging to be enabled in Salesforce Setup. Use this when you need to capture `System.debug()` output (e.g., HTTP response parsing, diagnostic information).
  - `options.logLevels` — Optional object specifying log levels for different categories (Apex_code, Callout, Db, etc.). Defaults: all `NONE` except `Apex_code: 'DEBUG'`
  - Returns: Standard execution result plus `debugLog` string containing all debug output
  - Internally delegates to `src/salesforce/soap/`: `buildExecuteAnonymousEnvelope` → `postSoapRequest` → `parseExecuteAnonymousResponse`. `ConnectionManager` stays focused on auth/connection state; SOAP envelope, HTTPS transport, and XML parsing are isolated modules.

### Communication Pattern

The webview and extension host communicate via `postMessage`:
- **Webview → Extension**: `vscode.postMessage({ type: 'someAction', ...data })`
- **Extension → Webview**: `panel.webview.postMessage({ type: 'someResponse', data })`

`MainPanel._route()` standardizes this: call a service method, post the result as `successType`, or catch and post error as `errorType`.

## Tabs & Features

| Tab | Status | Description |
|-----|--------|-------------|
| **Overview** | Working | Org info card, storage bars, SOQL query editor with results table |
| **Utils** | Active | Two sub-tabs: **Built-in** (Clone User, Reactivate OmniScript) + **Scripts** (YAML-loaded scripts from `force-cockpit/`) |
| **Monitoring** | Active | SOQL-powered Chart.js dashboards loaded from `force-cockpit/monitoring/` YAML configs |

### Sensitive org banner and script execution guard
A warning banner (`#production-warning`, `.production-warning`) is shown at the top of the panel (above the tabs) whenever the user is connected to a **sensitive org** — either a production org or a protected sandbox:
- **Production org**: `!org.sandboxName` → text: "Production org — changes will affect live data."
- **Protected sandbox**: `org.sandboxName && org.isProtectedOrg` → text: "Protected sandbox — changes will affect live data."
- **Non-protected sandbox**: banner hidden

The banner `textContent` is set dynamically in `setConnected()` in `media/main.js` before toggling visibility, so the static HTML placeholder text is overwritten at runtime.

**Generic action tracking (spinner + cancel)**: Every execute button uses `win.__startAction(btn, onCancel)` / `win.__endAction(opId)` defined in `media/main.js`:
- `__startAction(btn, onCancel)` — disables `btn`, adds a CSS spinner via `.btn.running::after`, injects a "✕ Cancel" sibling button, tracks the op in `_activeOps`, posts `operationStarted` to the extension host, returns `opId`.
- `__endAction(opId)` — re-enables `btn`, removes spinner and cancel button, posts `operationEnded`. Safe to call with `null`/`undefined`.
- `_cancelledOps` — a `Set<string>` of opIds whose late results should be dropped. Added when cancel is clicked or `cancelAllOperations` fires. Checked at the top of `window.addEventListener('message', ...)` before the switch — if matched, the message is swallowed and the opId is removed.
- Every result/error message echoes `opId` back because `_route` in `MainPanel.ts` merges the full request context (including `opId`) into both success and error responses.
- **True cancellation** for terminal commands: `runTerminalCommand` accepts an optional `AbortSignal`; on abort it kills the child process and resolves `{ cancelled: true }`. `MainPanel` creates one `AbortController` per op stored in `_activeTerminalOps`. The webview sends `cancelOperation` → extension calls `ac.abort()`.
- **JS vm script cancellation**: `Promise.race` with an abort promise — resolves `{ cancelled: true }` immediately while the VM may still be running in the background (result is suppressed via `_cancelledOps`).
- **Apex cancellation**: No true cancel; `__endAction` re-enables the button immediately and `_cancelledOps` suppresses the late result when it arrives.
- `__confirmIfSensitive` must always be called BEFORE `__startAction` — the button is only disabled after the user confirms.

**Org-switch guard**: `guardBusy(action)` in `extension.ts` checks `MainPanel.currentPanel?.hasActiveOperations`. If busy, shows a native `showWarningMessage({ modal: true })`; on confirm calls `cancelAllOps()` which aborts all terminal ops and posts `cancelAllOperations` to the webview. Applied in both `connectOrg` (before switching) and `disconnectOrg` commands. `_webviewBusyCount` in `MainPanel.ts` is kept in sync by `operationStarted`/`operationEnded` messages from the webview.

**Sensitive org confirmation**: Before executing any destructive action on a sensitive org, the user must confirm via `win.__confirmIfSensitive(orgData, label, onConfirmed, onCancelled?)` defined in `media/main.js`. This replaces the broken `window.confirm()` (silently returns `false` in VSCode webviews). The function sends a `confirmAction` message to the extension host, which shows a native `vscode.window.showWarningMessage({ modal: true })` and echoes the result back as `confirmActionResult`. Applied in:
- `src/features/utils/clone-user/view.js` — Clone execute button
- `src/features/utils/yaml-scripts/view.js` — Execute button handler for all script types (Apex/Command/JS). Stores `currentOrgData` from `onOrgConnected`; clears on disconnect.

**Opening Salesforce records from the webview**: Features post `{ type: 'openRecord', recordId }` to open a specific record in the browser. `MainPanel.ts` handles this globally (not per-feature): it calls `buildRecordUrl(org, recordId)` from `src/utils/salesforceUrl.ts` and opens it with `vscode.env.openExternal`. The `openInBrowser` command (opens org home) similarly uses `buildOrgUrl(org)` from the same utility. To add "Open in SF" to a feature, just post `openRecord` with the record Id — no route registration needed.

**`src/utils/terminalCommand.ts`** — shared `runTerminalCommand(command, workspaceRoot?)` utility. Uses `child_process.spawn` with `shell: true`. Appends stderr with `\n--- stderr ---\n` separator if non-empty. Returns `{ success: boolean, output: string }`. Used by `YamlScriptsService.executeTerminalCommand`.

### Clone User utility
Clones a Salesforce user by executing anonymous Apex. Copies profile, role, and all permission sets from a source user. Username generation:
- **Production**: `email.b2b`
- **Sandbox**: `email.b2b.sandboxname`

The sandbox name is parsed from the instance URL pattern `orgname--sandboxname.sandbox.my.salesforce.com`.

### YAML Scripts (Scripts sub-tab)
Scripts loaded dynamically from YAML files. Three script types are supported: **Apex** (requires org connection), **command** (local terminal command, no org needed), and **js** (JavaScript executed in a Node.js VM sandbox with optional jsforce access, no org required). Scripts are **user-defined only** — the `force-cockpit/scripts/` folder is excluded from the VSIX bundle (unlike monitoring). User scripts live at:

`{workspace root}/force-cockpit/scripts/{category}/*.yaml` — or `{forceCockpit.cockpitPath}/scripts/`. Created manually or via the "+ New" button in the UI. On extension activation, `force-cockpit/scripts/` and `force-cockpit/monitoring/` are auto-created in the workspace if they don't exist.

**Private scripts**: Users can flag a script as private (checkbox in the form) to save it to `force-cockpit/private/scripts/` instead. Private scripts are never committed to git — `extension.ts` automatically adds `force-cockpit/private/` to `.gitignore` on activation (`ensurePrivateGitignored`). The load order is **builtin < user (shared) < private** — all three are merged by ID and private wins. Saving a private script with the same category/name as a shared one (or vice versa) throws an error. Moving a script between shared and private (toggling the checkbox in edit mode) deletes from the old location and writes to the new one. Private scripts show a 🔒 badge in the accordion header.

**Sub-categories**: Scripts support 2 levels of folder nesting: `{category}/{sub-category}/*.yaml`. Clicking a parent category pill reveals a second row of sub-pills. `loadFromPath` walks both the parent and immediate subdirectory levels.

**Visibility filter**: A segmented control (All / Shared / Private / Favorites) above the category pills lets users show only shared, private, or favorite scripts. Changing the filter rebuilds category pills from the matching subset. Implemented by the shared filter bar (see below).

**Shared category/visibility filter bar** (`src/features/shared/view/`): both yaml-scripts and monitoring delegate their visibility segmented control, category pills, and sub-category pills to `createCategoryFilterBar({ visibilityEl, pillsEl, subPillsEl, visibilityOptions, labels, getItems, isFavorite?, onChange })`. The DOM factory (`category-filter-bar.js`) is a thin layer over the pure, unit-tested state core (`category-filter-state.ts`), which owns the `{ visibility, folder, subFolder }` triple (`subFolder` always a full `parent/sub` path), the match predicates (`matches`, `matchesVisibility`, `matchesFolder`), and `setState` (desired state) + `reconcile` (validated against actual folders at render time — so post-save flows can select a folder that only exists in the next list). `render()` rebuilds the three button rows and never fires `onChange` (reserved for user clicks); `reset()` clears state then renders (monitoring uses it on full reload). Each consumer keeps its own `applyFilters()` loop and feature-specific concerns (text search, monitoring's drag-handle hiding) and just calls `filterBar.matches({ folder, source, id? })` per item. Unified behaviors: re-clicking the active visibility button is a no-op; 'shared' means `source !== 'private'`.

Scripts are kept separate from monitoring configs: monitoring lives in `force-cockpit/monitoring/` (bundled in VSIX), scripts in `force-cockpit/scripts/` (not bundled). In `extension.ts`, both factories receive their sub-path: `path.join(builtInPath, 'scripts')` for yaml-scripts, `path.join(builtInPath, 'monitoring')` for monitoring. Both also receive `privatePath` (private sub-folder).

YAML structure:
```yaml
# Apex script — inline code
name: My Apex Script
description: What this script does.
apex: |
  System.debug('Hello');
  // Apex code executed anonymously
filter-user-debug: true   # optional (apex only): pre-check "Show only USER_DEBUG lines" in log viewer
format-json: true         # optional (apex only): pre-check "Format JSON" in log viewer

# Apex script — from file (path relative to workspace root)
name: My Apex Script
apex-file: force-cockpit/scripts/orders/my-apex.cls

# Terminal command — runs a local shell command in the workspace root (no org connection required)
name: My Command
command: npm run build

# Terminal command — from file
name: My Command
command-file: force-cockpit/scripts/utils/cleanup.sh

# JavaScript script — runs JS in a Node.js VM sandbox (org connection is optional, if we use jsforce, it's required)
name: My JS Script
js: |
  const result = await query("SELECT Id, Name FROM Account LIMIT 5");
  log(JSON.stringify(result.records, null, 2));

# JavaScript script — from file
name: My JS Script
js-file: force-cockpit/scripts/utils/my-query.js
```

All use the same `name` and `description` fields. Exactly one of `apex:`, `command:`, `js:`, `apex-file:`, `command-file:`, or `js-file:` is required.

**File-based scripts** (`apex-file`, `command-file`, `js-file`): the value is a path **relative to the workspace root**. The file must exist inside the workspace (path traversal outside the workspace is rejected). The file is read fresh on every `loadYamlScripts` call. If the file is missing or outside the workspace the script is rendered as ⚠ Invalid with a descriptive error. In the form UI, selecting "From file" as the Source hides the inline textarea and shows a file path input with a 📁 Browse button that opens a workspace-scoped file picker (`vscode.window.showOpenDialog` defaulting to the workspace root).

**Configurable Inputs**: Scripts can define an optional `inputs:` field to declare dynamic input variables. Each input has `name` (identifier used in `${name}` placeholders), optional `label` (display text, defaults to name), optional `type` (`string`, `picklist`, `checkbox`, or `textarea`, defaults to `string`), optional `required` (boolean, ignored for `checkbox`), for `picklist` type an `options` list, and for `checkbox` type an optional `default` boolean (defaults to `false`). Example:
```yaml
inputs:
  - name: orderId
    label: Order ID
    required: true
  - name: status
    label: Status
    type: picklist
    required: true
    options:
      - New
      - Completed
      - Cancelled
  - name: includeArchived
    label: Include archived records
    type: checkbox
    default: true   # optional; defaults to false if omitted
  - name: itemList
    label: Items (one per line)
    type: textarea
    required: true
```
Users write `${varName}` in their script code. At execution time, placeholders are substituted with type-appropriate escaping: Apex escapes single quotes (`'` → `''`) and newlines (`\n` → `\n` escape sequence), JS uses JSON-safe escaping, command passes raw values. Checkbox inputs substitute `true` or `false` (no quotes) — safe as boolean literals in Apex/JS or as strings in commands. In the accordion UI, `string` inputs render as text fields, `picklist` inputs as `<select>` dropdowns, `checkbox` inputs as a labelled checkbox (pre-checked when `default: true`), and `textarea` inputs as a resizable multi-line textarea (useful for pasting newline-separated lists). Execute is disabled until all required inputs are filled (checkboxes always count as filled).

**System placeholders**: In addition to user-defined inputs, scripts support built-in system placeholders that are automatically resolved from the current org context. They use the same `${name}` syntax and are substituted **after** user inputs (so a user-defined input with the same name takes precedence). Available system placeholders:
- `${orgUsername}` — the Salesforce username (not alias) of the connected org. Resolves to empty string when no org is connected.

System placeholders are type-escaped identically to user inputs (Apex, JS, command). To add more system placeholders, extend the `systemVars` object in `YamlScriptsService.substituteSystemPlaceholders()`.

**JS scripts** execute in a Node.js `vm` sandbox (`createContext` + `Script`). The context provides: `connection` (raw jsforce `Connection` or `null`), `org` (`OrgDetails` or `null`), `query(soql)` (convenience wrapper), `log(...args)` / `error(...args)` (captured as output), `console` (`{ log, error, warn }`), `fs`, `path`, `yaml`, `setTimeout`, `clearTimeout`, `Promise`. The code is wrapped in an async IIFE so `await` works at top level. Output from `log()` / `console.log()` is returned as the debug log. JS scripts show a green `[JS]` badge, their Execute button is always enabled (no org needed), and no USER_DEBUG checkbox is shown.

Command scripts show a `[cmd]` badge in the accordion header and their Execute button is always enabled (no org needed). Apex scripts show a "Show only USER_DEBUG lines" checkbox in the log viewer; command and JS scripts do not (output is raw). Command execution runs in the workspace root directory. `--- stderr ---` separator is added if stderr output is present.

After execution, an **"Open in editor"** button appears below the output `<pre>` whenever there is non-empty output. Clicking it sends `{ type: 'openScriptResult', content }` to the extension, which opens the raw (unfiltered) log in a new untitled VSCode text buffer via `vscode.workspace.openTextDocument({ content, language: 'plaintext' })`. The button is hidden on reset (new execution start) and when output is empty. Route: `openScriptResult` → `openScriptResultDone` / `openScriptResultError` in `src/features/utils/yaml-scripts/index.ts`.

Each script gets an accordion with an Execute button visible in the collapsed header (no expand required). Clicking Execute auto-expands the accordion to show the output. Apex execution uses `executeAnonymousWithDebugLog` (SOAP, no Setup required). The description appears once (in the accordion header subtitle); there is no duplicate `card-description` in the body.

**`src/features/utils/yaml-scripts/`** — the yaml-scripts feature module. The service is a thin facade over focused collaborators:
- `types.ts` — shared interfaces (`YamlScript`, `ScriptInput`, `ExecuteScriptResult`, `SaveScriptInput`, `ScriptType`).
- `YamlScriptsService.ts` — orchestrator only (~120 lines). `loadScripts()` → `ScriptParser`. `executeScript()` validates required inputs, runs placeholder substitution, dispatches to the executor matching `script.type`, saves the execution log. `saveScript`/`updateScript`/`deleteScript` → `ScriptRepository`.
- `parsing/ScriptParser.ts` — YAML file → `YamlScript`. Chain of focused helpers: `readRawYamlFile` → `parseYamlContent` → `validateYamlDoc` → `detectScriptKind` → `resolveScriptContent` → `makeInvalidScript`. Invalid YAML files (parse errors, missing name, missing apex/command/js, ambiguous) are surfaced as `YamlScript` entries with `invalid: true` and `error: string` instead of being silently dropped.
- `parsing/PlaceholderResolver.ts` — pure module: `escapeForType`, `substituteVars`, `substituteInputs`, `substituteSystemPlaceholders`, `validateRequiredInputs`. No class, no deps. System placeholders (e.g. `${orgUsername}`) are injected by the service via a `systemVars` dict — the resolver stays pure and testable.
- `execution/ApexExecutor.ts` — executes Apex via `ConnectionManager.executeAnonymousWithDebugLog` with `assertApexSuccess`, returns `ExecuteScriptResult` with the debug log (+ filtered USER_DEBUG view).
- `execution/CommandExecutor.ts` — executes shell commands via `runTerminalCommand` in the workspace root. Supports `AbortSignal` and streaming log chunks.
- `execution/JsExecutor.ts` — runs user JS in a Node.js `vm` sandbox (`createContext` + `Script`). Context: `connection`, `org`, `query`, `log`/`error`, `console`, `fs`, `path`, `yaml`, `xmlFormat`, `DOMParser`, `XMLSerializer`, `xml`, `input`, `xmlEscape`, `setTimeout`, `clearTimeout`, `Promise`. Async IIFE wrap so top-level `await` works. `AbortSignal` via `Promise.race`.
- `persistence/ScriptRepository.ts` — all file I/O: `save`/`update`/`delete` under user or private path, `saveExecutionLog` under `{userBasePath}/logs/` (auto-creates with `.gitignore`). Uses `toSlug` from `src/utils/slug.ts` (shared with monitoring).
- `view/` — webview source as ES modules. **Bundled** by a dedicated esbuild call into `dist/features/utils/yaml-scripts/view.js` (single `<script>` loaded by `WebviewAssets`). `scripts/copy-feature-assets.js` skips `view/` directories so the raw sources never reach `dist/`. Sub-modules:
  - `view/index.js` — entry point IIFE: DOM refs, label init, top-level state (`connected`, `currentOrgData`, `favoriteIds`, etc.), the new/edit form controller, message dispatch, feature registration. Wires the sub-modules below via factory invocations. Category/visibility filtering is delegated to the shared `createCategoryFilterBar` from `src/features/shared/view/category-filter-bar.js`.
  - `view/log-rendering.js` — pure: `renderLogWithLinks`, `renderLogWithJsonTables` (and helpers `deepParseJson`, `renderJsonCell`, `renderJsonAsTable`). String-in/string-out, no DOM mutation, no shared state.
  - `view/code-editor.js` — `createCodeEditor({ textarea, codeEl, gutter, hljs })` returns `{ getContent, setContent, setLanguage, setPlaceholder }`. Self-contained textarea + highlight.js overlay + line-number gutter, throttled via `requestAnimationFrame`.
  - `view/form-inputs-editor.js` — `createFormInputsEditor({ listEl, addBtn, labels })` returns `{ getInputs, setInputs, clear }`. Owns the dynamic `inputs:` definition rows in the new/edit form (string / picklist / checkbox / textarea sub-rows).
  - `view/accordion-builder.js` — `createAccordionBuilder(ctx)` returns `{ buildAccordion, updateFavoriteStars }`. Builds per-script accordions including header, type/private badges, favorite star, edit button, input fields, and the log viewer with USER_DEBUG / JSON-table toggles. `ctx` injects everything it needs (`labels`, `scriptsList`, `favoriteIds`, the two op-tracking Maps, `getConnected`/`getCurrentOrgData` getters, `onEditClick` callback, the log renderers, and `vscode`/`startAction`/`confirmIfSensitive`/`escapeHtml` from `window.__*`) so the module never reaches into `view/index.js`'s scope directly.
- `index.ts` — manual factory `createYamlScriptsFeature({ builtInPath, userPath, workspaceRoot })` (NOT using `defineFeature` — needed to inject the path config). Imports `vscode` for the delete confirmation dialog. Uses `tab: 'utils-scripts'` → injects into `<!-- features:utils-scripts -->` in main.html. Routes: `loadYamlScripts`, `executeYamlScript`, `saveYamlScript`, `updateYamlScript`, `deleteYamlScript`. The `deleteYamlScript` route calls `vscode.window.showWarningMessage({ modal: true })` before deleting — returns `{ deleted: false }` if the user cancels (no error thrown).
- Assembled in `extension.ts` alongside `featureRegistry`; passed to `MainPanel.createOrShow` as the combined `allFeatures` array.
- **Accordion header pattern**: each accordion uses a `.yaml-script-header` flex row containing `.accordion-trigger` (flex:1, toggles open/close) + optional `.yaml-edit-btn` (user scripts only) + `.yaml-execute-btn` (always visible). `view.css` contains a scoped `width: auto` override for `.accordion-trigger` inside `.yaml-script-header` so the global `width: 100%` rule in `main.css` doesn't break the flex layout.
- **Invalid scripts**: rendered with a red `⚠ Invalid` badge, the error shown in the accordion body (pre-expanded), Execute button disabled. User invalid scripts also get a `✏` edit button so the user can fix the YAML from the UI. CSS: `.script-invalid-badge`, `.yaml-script--invalid`.
- **"+ New" button**: opens an inline form (`#yaml-new-form`) with Name, Description, Type dropdown (Apex/Command/JavaScript), Category field (custom combobox — input + `▾` toggle button + absolutely-positioned dropdown div), and Content textarea. The combobox shows all existing category options when opened and allows free-text for new categories. Native `<datalist>` was avoided because it mis-positions in VSCode's webview and filters options by current input value. On save: calls `saveYamlScript` route → reloads list → scrolls new script into view with a 1.5s focus highlight animation.
- **Edit (✏) button**: shown in the accordion header for all user scripts (valid + invalid). Clicking it pre-fills the shared form (`#yaml-new-form`) with the script's current values and sets `editingScriptId`. On save: calls `updateYamlScript` route → reloads list → highlights updated script. The form's Delete button is visible only in edit mode.
- **Delete button**: inside the edit form only (`.yaml-form-delete-btn`, red destructive style, pushed right via `margin-left: auto`). Sends `deleteYamlScript` message → extension shows a VSCode native modal confirmation → on confirm deletes the file and reloads the list; on cancel the form stays open. CSS: `.yaml-edit-btn`, `.yaml-form-delete-btn`.

**Utils sub-tab pattern** (`main.html` / `main.css` / `main.js`):
- `.utils-sub-tab-bar` + `.utils-sub-tab[data-utils-tab]` buttons
- `.utils-sub-tab-panel[id="utils-sub-tab-{name}"]` panels (toggled by `main.js`)
- Built-in sub-tab contains `<!-- features:utils -->` and its own `.feature-filter-input`
- Scripts sub-tab contains `<!-- features:utils-scripts -->`
- Filter scoping fix: `input.closest('.utils-sub-tab-panel') || input.closest('.tab-content')`

**When `defineFeature` is NOT appropriate**: use a manual `FeatureModuleFactory` function (like `createYamlScriptsFeature`) when the service needs constructor arguments beyond `ConnectionManager` (e.g. a file path from VSCode config). Assemble in `extension.ts` and pass as part of `allFeatures` to `MainPanel.createOrShow`.

**Stale dist files**: `scripts/copy-feature-assets.js` does not clean `dist/features/` before copying. When deleting a feature, also manually delete `dist/features/{tab}/{id}/` to avoid stale files in the VSIX.

### Monitoring tab (`src/features/monitoring/monitoring-dashboard/`)
SOQL-based Chart.js dashboards. Configs are YAML files in `force-cockpit/monitoring/{category}/*.yaml`. Two sources merged: bundled extension path + user workspace path (same pattern as yaml-scripts).

**YAML schema**:
```yaml
name: Chart Name
description: What this shows.
soql: SELECT Field, COUNT(Id) Cnt FROM Object GROUP BY Field
labelField: Field          # API name used as X-axis / pie labels / first table column
                           # Not required when chartType: metric
valueFields:               # one or more datasets / table columns
  - field: Cnt
    label: Count
    format: currency       # optional: currency | percent (applied to axes, tooltips, table cells)
    threshold: 100         # optional: trigger a VSCode warning notification when any value meets the condition
    thresholdCondition: above  # optional: 'above' (≥, default) or 'below' (≤); omit when 'above'
chartType: bar             # bar | line | pie | doughnut | metric | table
stacked: false             # true = stacked bars/lines (bar and line only)
notifyOnIncrease: false    # true = fire a VSCode warning when totalRows grows between two refreshes
refreshInterval: 0         # seconds; 0 = manual refresh only
```

**Chart types**:
- `bar | line | pie | doughnut` — rendered with Chart.js canvas. View-mode type selector allows on-the-fly switching between these four.
- `metric` — KPI card: displays the first value of the first `valueField` as a large number. `labelField` is not required. No canvas.
- `table` — scrollable HTML table. Works with any SOQL (aggregate or not). Columns = `labelField` + `valueFields`. Click column headers to sort client-side. No canvas. **Record-Id linking**: cells whose value is an 18-character Salesforce Id with a valid case-safe checksum auto-render as clickable links (`.monitoring-record-link`) that post `{ type: 'openRecord', recordId }` to the host. The host's existing `openRecord` route in `MessageRouter` opens the record via `buildRecordUrl`. Detection is value-based and column-name-agnostic — works for `Id`, `OwnerId`, any `*Id` lookup, and aliased columns. Validation lives in [src/utils/salesforce.ts](src/utils/salesforce.ts) (`isSalesforceRecordId` + `computeIdSuffix`); 15-char Ids are intentionally not recognised because SOQL returns 18-char Ids and 15-char strings have no checksum to verify. **Per-table search filter**: each table card includes a `.monitoring-table-filter` input above the table that filters rows by case-insensitive substring match across all columns; an `X of Y` match counter (`.monitoring-table-match-count`) appears next to the input. Render-state (latest data, sort col/dir, tbody handle, filter/counter elements) is stashed on the wrapper as `wrapper._tableState` so the single `applyFilterAndSort(wrapper)` helper drives both filter input and sort header clicks; this avoids stale closures across auto-refresh and lets the filter text + sort persist while data is reloaded. The wrapper is now a flex column (`.monitoring-table-wrapper`) holding a `.monitoring-table-toolbar` + a separate scrollable `.monitoring-table-scroll` region (so the filter stays fixed above the scrolling rows).

**Format values** (`valueFields[].format`): `currency` → `toLocaleString` with 2 decimal places. `percent` → `toFixed(1) + '%'`. Applied in chart tooltips, y-axis tick callbacks, and table cells (display only — does not modify stored data).

**Private configs**: Same pattern as yaml-scripts — users check "Private" in the edit form to save to `force-cockpit/private/monitoring/`. Three-way merge: builtin < user < private. Duplicate ID across shared/private is blocked. Private cards show a 🔒 badge. Visibility filter (All / Shared / Private) and sub-category pills work identically to yaml-scripts — both use the shared `createCategoryFilterBar` from `src/features/shared/view/` (see the YAML Scripts section).

**Sub-categories**: Monitoring configs support 2-level nesting: `{category}/{sub-category}/*.yaml`. `loadMonitoringYamlFiles()` helper handles per-directory YAML loading, called for both the parent and each immediate subdirectory.

**Factory**: `createMonitoringDashboardFeature({ builtInPath, userPath, privatePath, workspaceState })` — manual factory; `builtInPath = {extensionPath}/force-cockpit/monitoring`, `userPath = {userBasePath}/monitoring`, `privatePath = {userBasePath}/private/monitoring`. Wired in `extension.ts` alongside `createYamlScriptsFeature`.

**Snooze persistence**: Threshold breach notification snoozes ("Snooze 1h", "Snooze for today") are persisted via `workspaceState` under key `monitoring.notificationCooldowns` as a `Record<string, number>` (cooldownKey → timestamp). Loaded on factory init with expired entries pruned. Only explicit user snoozes are persisted — the default 1-minute dedup cooldown is ephemeral and filtered out by the `persistSnoozes` helper.

**Row-count increase notifications**: A per-config `notifyOnIncrease: true` YAML flag fires a plain VSCode warning whenever `result.totalRows` grows between two non-preview refreshes. Implemented in [src/features/monitoring/monitoring-dashboard/notifications.ts](src/features/monitoring/monitoring-dashboard/notifications.ts) via `checkRowCountIncrease(...)` + a process-local `previousRowCounts: Map<configId, number>`, fired through a dedicated `fireRowCountNotifications(messages)` helper that calls `vscode.window.showWarningMessage(msg)` with **no snooze actions and no cooldown** — each notification represents a discrete "more records arrived" event, so re-firing only happens when the count grows again. The baseline updates on every refresh (in-memory only — first refresh after extension reload silently establishes it). The baseline is cleared on `saveMonitoringConfig` (so SOQL/flag changes restart the comparison) and on `deleteMonitoringConfig` (alongside `clearAllCooldownsFor`). The view passes `notifyOnIncrease` in every `runMonitoringQuery` / `runMonitoringTableQuery` payload so the host stays stateless about per-config settings.

**Background auto-refresh (panel-closed notifications)**: Notification-enabled dashboards (any `valueField.threshold != null` OR `notifyOnIncrease: true`) keep polling and firing notifications even when the Force Cockpit panel is closed. Ownership of the timer is **host-side**:
- [BackgroundRefresher.ts](src/features/monitoring/monitoring-dashboard/BackgroundRefresher.ts) — `BackgroundRefresher` class with `start(configs)`, `stop()`, `restart(configs)`. Filters configs to only those that match `hasNotifications(cfg)` and have `refreshInterval > 0`. Skips `__preview__*` ids. Enforces the same 10s minimum as the webview. Each tick checks `connectionManager.isConnected`, calls `service.runQuery` (chart/metric) or `service.runTableQuery` (table), runs `checkThresholds` + `fireBreachNotifications` + `checkRowCountIncrease` + `fireRowCountNotifications` from `notifications.ts`, and posts `monitoringBackgroundRefreshResult` to the panel (no-op when the panel is closed).
- [notifications.ts](src/features/monitoring/monitoring-dashboard/notifications.ts) — single shared module owning `notificationCooldowns` and `previousRowCounts` Maps. Imported by both the route handlers and the BackgroundRefresher so cooldowns and row-count baselines stay consistent across host/route/refresher.
- [extension.ts](src/extension.ts) — listens on `connectionManager.on('connectionChanged', ...)`. On connect: `monitoringFeature.reloadConfigs()` then `refresher.restart(configs)`. On disconnect: `refresher.stop()`. The refresher is also added to `context.subscriptions` for clean shutdown on deactivate.
- `createMonitoringDashboardFeature` now returns `{ factory, refresher, reloadConfigs }`. When `connectionManager` is passed in opts (production path) the service + refresher are constructed eagerly so the refresher can run before the panel is ever opened. When omitted (legacy test path) construction is deferred until `MainPanel` invokes the factory.
- The webview's [view/index.js](src/features/monitoring/monitoring-dashboard/view/index.js) skips its own `setupAutoRefresh` timer for any config where `hasNotifications(cfg)` is true — the host owns those. It also handles a new `monitoringBackgroundRefreshResult` message that routes through the existing `onQueryResult` / `onTableQueryResult` render path. The `panelVisibilityChanged` resume hook also skips notification configs to avoid double-firing on visibility regain.
- `MainPanel.postWebviewMessage(msg)` is a generic post hook used by the refresher's `postToWebview` callback wired up in `extension.ts`.
- **Audio cue**: row-count growth notifications also play a short OS sound. The cue lives in [audio.ts](src/features/monitoring/monitoring-dashboard/audio.ts) (`playRowCountPing`) and is invoked by `fireRowCountNotifications` in `notifications.ts` so every code path (route handler + BackgroundRefresher) gets it for free. It uses `child_process.spawn` per `process.platform`: `afplay` (macOS, Glass.aiff), `powershell.exe -Command [console]::beep(880,300)` (Windows), `paplay` (Linux, freedesktop message.oga). All failures (binary missing, audio device unavailable) are swallowed — best-effort. The webview's old Web Audio `playNotificationPing` was removed; the host now owns the cue so it plays even when the panel is closed.

**Routes**: `loadMonitoringConfigs`, `runMonitoringQuery` (chart/metric), `runMonitoringTableQuery` (table), `saveMonitoringConfig`, `saveMonitoringPositions`, `deleteMonitoringConfig`, `restoreHiddenBuiltins`.

**Delete + hidden built-ins**: A red Delete button in the card edit form (visible whenever `configId` is non-null) posts `deleteMonitoringConfig` with `{ configId, configName, source, isPrivate }`. The host shows a `vscode.window.showWarningMessage({ modal: true })` and returns `{ deleted: false }` on cancel (no-op) or `{ deleted: true }` after acting. For `source === 'user' | 'private'` the YAML file is unlinked via `MonitoringDashboardService.deleteConfig(id, isPrivate)`. For `source === 'builtin'` the id is added to a "hidden built-ins" set persisted in `workspaceState` under key `monitoring.hiddenBuiltins` (string[]); `loadConfigs(hiddenBuiltinIds)` filters those out at load time. After every delete, `clearAllCooldownsFor(configId, workspaceState)` removes any threshold cooldowns keyed under that id. The `loadMonitoringConfigsResult` payload includes `hiddenCount`; when > 0, the view renders a "Restore hidden built-ins (N)" link in `.monitoring-toolbar-top`. Clicking it posts `restoreHiddenBuiltins` which clears the set and triggers a config reload.

**Chart.js delivery**: `scripts/copy-vendor-assets.js` copies `node_modules/chart.js/dist/chart.umd.js` → `dist/vendor/chart.umd.js`. `MainPanel._getHtml()` generates `chartJsUri` from `dist/vendor/`, adds `dist/vendor/` to `localResourceRoots`, replaces `${chartJsUri}` in `main.html`. The `<script nonce defer>` tag in `main.html` loads Chart.js before all feature scripts. `window.Chart` is available globally in all feature view.js files.

**highlight.js delivery**: `scripts/build-highlightjs.js` bundles `highlight.js/lib/core` + three language grammars (apex via `highlightjs-apex`, javascript, bash) via esbuild into a single IIFE → `dist/vendor/highlightjs.bundle.js` exposing `window.hljs` with all three languages pre-registered. `MainPanel._getHtml()` generates `highlightJsUri` and replaces `${highlightJsUri}` in `main.html`. Entry point: `src/vendor/highlightjs-entry.js`. The YAML scripts code editor uses a `<textarea>` + `<pre><code>` overlay pattern — the textarea handles input/undo natively (no contenteditable issues), while highlight.js renders syntax-highlighted code in the overlay behind it.

**UI**: Card grid (2 columns). Each card has view mode (chart/metric/table + type selector for chart types + Edit + Refresh) and edit mode (inline form with auto-preview on SOQL change, 800ms debounce). Edit form shows/hides label field row (hidden for metric), stacked checkbox (only for bar/line), and format dropdown per value field. `[Save]` writes YAML to user workspace path. Built-in bundled configs are read-only — edits always save to user path. `[+ Add Chart]` creates a new blank card in edit mode.

**Save target**: `{userPath}/{folder}/{slug}.yaml` for shared configs, `{privatePath}/{folder}/{slug}.yaml` for private ones. Never overwrites bundled extension configs. The config id always follows the *current* category + name (`{folder}/{slug}`): changing either on an existing user/private config writes the new file and deletes the old one (move semantics — the webview sends the previous `source` in `saveMonitoringConfig` so the host knows which base path the old file lives in). Toggling the Private checkbox likewise moves the file between shared and private (the duplicate-id check exempts the config's own previous file). Builtin files are never deleted. Nested categories (`parent/sub`) are created recursively.

## Build & Package

```bash
npm run build        # copy-feature-assets + copy-vendor-assets + build-highlightjs + esbuild (extension.ts → dist/extension.js) + esbuild (yaml-scripts/view/index.js → ...) + esbuild (monitoring-dashboard/view/index.js → ...)
npm run watch        # same as build but in watch mode (for development)
npm run compile      # tsc type-check only
npm run package      # build + vsce package → .vsix file
```

The extension uses **esbuild** to bundle all dependencies (including `jsforce`, `js-yaml`) into a single `dist/extension.js`. `chart.js` and `highlight.js` are NOT bundled by esbuild — they are webview vendor files served via `dist/vendor/` and loaded in the webview sandbox separately. This is critical — without bundling, the VSIX won't include `node_modules` and the extension fails to activate silently.

### Installing the VSIX
```bash
code --install-extension force-cockpit-0.0.1.vsix
```
Or: Extensions panel → `...` → Install from VSIX.

## Key Conventions

- **Small methods, single responsibility** — every implementation must avoid long methods and classes/functions that take on too many responsibilities. Keep functions short and focused on one job; when a method grows or starts mixing concerns, extract focused collaborators (the way `YamlScriptsService` delegates to `ScriptParser`/`PlaceholderResolver`/executors, or `extension.ts` delegates the connection state machine to `OrgConnectionController`). Prefer composition of small, testable units over large multi-purpose blocks.
- **VSCode CSS variables** for all colors — never hardcode colors (ensures theme compatibility).
- **Accordion pattern** for Utils tab — each utility is a collapsible section.
- **Feature filter** — every non-overview tab has a `.feature-filter` search input (in `main.html`) that filters visible sections client-side. Logic is in `main.js`; styles in `main.css` (`.feature-filter`, `.feature-filter-input`, `.feature-no-results`). Filters reset on tab switch.
- **`.feature-actions`** shared CSS class in `main.css` for action button rows (flex, gap 12px). Use this instead of per-feature action row classes.
- **Paste-from-clipboard button** — wrap any `<input type="text/email">` in a `<div class="input-with-paste">` and add `<button type="button" class="paste-btn" title="Paste from clipboard">📋</button>` immediately after the input. A single delegated handler in `media/main.js` handles all paste buttons. For inputs inside flex-row containers (`.clone-search-row`, `.ro-filter-row`), add `style="flex: 1; min-width: 0"` to the wrapper to preserve the horizontal layout. Selects and checkboxes do not get paste buttons. `<textarea>` inputs in static HTML do not get paste buttons, but `textarea` execution inputs in yaml-scripts do — use `<div class="input-with-paste input-with-paste--textarea">` (block + relative positioning) with the paste button positioned absolute top-right. For dynamically generated inputs (yaml-scripts execution inputs), create the wrapper and button via JS before appending to the DOM.
- **Result/error boxes** (`.success-box`, `.error-box`) must be flat empty `<div>` elements with `style="display: none"`. Never nest child elements inside them in the HTML — the `:empty` CSS rule depends on them being empty. Build inner content dynamically in JS or use separate sibling elements.
- **Salesforce operations** that modify data use `executeAnonymous` (Apex) via the Tooling API, not direct DML through jsforce.
- The `.vscodeignore` excludes `.sfdx/`, `.sf/`, `.claude/`, `node_modules/`, `src/`, `out/`, and `*.map` from the VSIX.
- Always run `npm run package` after changes to generate an updated `.vsix`.
- **Unit tests** use **Vitest** (`npm test`). Test files live alongside the source as `*.test.ts`. All tests are pure unit tests — no real Salesforce org, no network calls. Mock pattern: `function makeMock(overrides = {}): ConnectionManager { return { ... } as unknown as ConnectionManager; }`. Private methods are accessed via `(service as any).method()`. Files with `beforeEach`/`afterEach` must place them inside a `describe` block (not at module scope) to avoid a Vitest v4 runner crash. Test files with test coverage: `apexUtils.ts`, `CloneUserService.ts`, `ReactivateOmniscriptService.ts`, `YamlScriptsService.ts`, `MonitoringDashboardService.ts`, `config.ts`, `category-filter-state.ts`, `OrgConnectionController.ts`, `orgType.ts`, `workspaceSetup.ts`.

## Org Connection — File Watcher Pattern

There is no sidebar or manual connect/disconnect UI. Org selection is delegated entirely to the Salesforce/SFDX extension. The extension monitors `.sf/config.json` in the workspace root.

The state machine itself lives in **`src/services/OrgConnectionController.ts`** (no `vscode` import — all environment dependencies are injected via the `OrgConnectionDeps` interface: `readTargetOrg`, `getOrgDetails`, `refreshOrgToken`, `guardBusy`, `notifyConnecting`, `showWarning`/`showInfo`/`log`, plus injectable `retryDelaysMs`/`debounceMs` for fast tests). `extension.ts` instantiates it, injects `readTargetOrg` (reads/parses `.sf/config.json`) and the `vscode` glue, wires the watcher events to `scheduleConnect()` / `handleConfigDeleted()`, and registers `forceCockpit.refreshOrg` → `connectFromConfig({ force: true })`. Fully unit-tested in `OrgConnectionController.test.ts` (version-race, retry, debounce, guard-decline, read-error paths).

- **On activation**: reads `target-org` from `.sf/config.json` and auto-connects. Silent — failures swallowed (workspace may not be an SFDX project, or auth may be stale).
- **On file change/create** (`watcher.onDidChange` / `onDidCreate`): `scheduleConnect()` debounces 300ms → `connectFromConfig()` reads new `target-org` → if same org, no-op; if different (or removed), calls `guardBusy(...)` → on confirm, disconnects and reconnects. The panel updates automatically via the `connectionChanged` event — no `createOrShow` call needed. A `connectVersion` counter (a controller field) ensures overlapping `connectFromConfig()` invocations are safe: each call captures its generation at entry and bails out after every `await` if a newer call has started.
- **Connection retry**: after disconnecting, `connectFromConfig()` immediately calls the injected `notifyConnecting(target)` (`MainPanel.currentPanel?.notifyConnecting`) to show a connecting spinner in the Overview tab (amber pulsing status dot + spinner). It then retries up to 4 times (delays 2s, 4s, 8s between attempts — `retryDelaysMs`). Each attempt re-reads credentials via `getOrgDetails(target)` (clears `StateAggregator` cache to pick up any token written to disk since the last attempt). Between attempts, `refreshOrgToken(target)` from `src/utils/sfCli.ts` runs concurrently with the delay timer — it spawns `sf org display --target-org "..." --json` to trigger the SF CLI's built-in OAuth2 token refresh, so the subsequent `getOrgDetails` reads a fresh access token. `refreshOrgToken` is best-effort (errors silently ignored). The version counter is checked before each retry — if the org changed again mid-retry the loop exits silently. The warning message is only shown after all attempts fail.
- **`notifyConnecting(orgName)`** on `MainPanel` — posts `{ type: 'orgConnecting', orgName }` to the webview, which calls `setConnecting()` in `main.js`. This shows `#connecting-state` (spinner + label) in the Overview tab and hides `#empty-state` and `#connected-content`. Cleared automatically when `orgConnected` or `orgDisconnected` is received.
- **On file delete** (`watcher.onDidDelete`): `handleConfigDeleted()` disconnects immediately if connected.
- `guardBusy(message)` in `extension.ts` — checks `MainPanel.currentPanel?.hasActiveOperations`, shows a VSCode modal warning, calls `cancelAllOps()` on confirm. Returns `true` to proceed, `false` to abort. Injected into the controller so it never touches the panel singleton directly.
- **Manual refresh** (`forceCockpit.refreshOrg` command): calls `connectFromConfig({ force: true })` which re-reads `.sf/config.json` and forces a disconnect+reconnect even when the same org is already connected (so stale tokens get refreshed). Surfaced in the webview as a 🔄 button next to the connection status indicator (always visible) and as a 🔄 Refresh action inside the empty-state card. Webview posts `{ type: 'refreshOrg' }`; `MessageRouter` executes the command and posts back `refreshOrgDone` to re-enable the button. Respects `guardBusy` like the auto-switch path.
- Registered commands: `forceCockpit.openPanel`, `forceCockpit.openInBrowser`, `forceCockpit.refreshOrg`.

## Dependencies

- `@salesforce/core` (v8) — Official Salesforce CLI library. Used via `StateAggregator` to read org auth files and aliases (handles both SFDX v1 `~/.sfdx/` and SF CLI v2 `~/.sf/orgs/`, decrypts tokens automatically). Bundled into dist.
- `jsforce` (v3) — Salesforce API client (bundled into dist)
- `js-yaml` (v4) — YAML parser for force-cockpit scripts (bundled into dist)
- `highlight.js` — Syntax highlighting for the YAML scripts code editor (webview vendor bundle, not esbuild-bundled)
- `highlightjs-apex` — Apex language grammar for highlight.js (bundled into the highlight.js vendor bundle)
- `esbuild` — Bundler (dev)
- `@vscode/vsce` — VSIX packaging (dev)
- Requires `sf` CLI installed on the user's machine for `openOrgInBrowser` (org open command only)

Note: `package.json` includes `"overrides": { "eslint": "^10.0.0" }` to resolve a pre-existing peer dependency conflict between `eslint@10` and `@typescript-eslint/eslint-plugin@8.55.0`.

## Adding a New Utility (end-to-end)

1. **Create a feature folder** `src/features/utils/{feature-id}/` with these files:
   - `index.ts` — use `defineFeature()` from `../../defineFeature`. Only declare `id`, `tab`, `Service` class, and `routes`. Asset paths are derived automatically. Example:
     ```ts
     import { MyService } from './MyService';
     import { defineFeature } from '../../defineFeature';
     export const myFeature = defineFeature({
       id: 'my-feature', tab: 'utils', Service: MyService,
       routes: (svc) => ({ /* message type → handler + successType + errorType */ }),
     });
     ```
   - `MyFeatureService.ts` — business logic class; receives `ConnectionManager`; no vscode imports; throws on error. For Apex operations, use `assertApexSuccess(result)` from `../../apexUtils`
   - `view.html` — the `<section class="accordion">` HTML fragment. Use `class="feature-actions"` for action button rows
   - `labels.js` — sets `window.MyFeatureLabels` with all user-facing strings (button text, placeholders, error/status messages); no `@ts-check`
   - `view.js` — webview IIFE; use `const win = /** @type {any} */ (window)` to access `win.__vscode`, `win.MyFeatureLabels`, `win.__registerFeature`, `win.__escapeHtml`; calls `win.__registerFeature(id, { onOrgConnected, onOrgDisconnected, onMessage })`; use `win.__escapeHtml(str)` for HTML escaping; use `// @ts-check` with JSDoc annotations
   - `view.css` — feature-specific styles using VSCode CSS variables (only for styles not covered by shared classes)
2. **Register**: add one import line to `src/features/registry.ts` and add to the array
3. **Rebuild**: `npm run package`

No changes to `MainPanel.ts`, `main.html`, or `main.js` are needed.

## Adding a New Tab

1. Add `<button class="tab" data-tab="tab-id">` in the tab bar in `main.html`
2. Add `<div class="tab-content" id="tab-tab-id">` section in `main.html`
3. Tab switching is handled automatically by the existing JS in `media/main.js`

Always check that we are not duplicating code, if we see that something can be reused we extract it and reuse it everywhere needed.

**Refactoring backlog**: `docs/refactoring/` holds prioritized, ready-to-execute refactoring docs (problem, approach, test plan, risks). Pick the lowest-numbered one when asked for "the next refactoring". The folder is excluded from the VSIX via `.vscodeignore`.

Always include an "Update CLAUDE.md" step to reflect important architectural changes/decisions as the last step of a plan or requests from the developer.

Always include an "Update README.md" step when changes affect user-facing behaviour, new features, configuration options, or setup steps — so the README stays accurate for end users.

## CI/CD

Two GitHub Actions workflows live in `.github/workflows/`:

### `pr-validate.yml` — PR quality gates
Triggered on every `pull_request` targeting `main`. Runs six parallel jobs:
- `ESLint` — `npm run lint`
- `Prettier` — `npm run format:check`
- `TypeScript` — `npm run compile`
- `Vitest` — `npm test`
- `Security Audit` — `npm audit --audit-level=high --omit=dev` (production deps only)
- `Build & Package` (depends on all above) — `npm run build` + `npm run package` + uploads VSIX as a 7-day artifact for manual reviewer testing

All jobs use Node 20, `npm ci` with cache, and `HUSKY=0` to suppress git hook installation on CI. All GitHub Actions are pinned to commit SHAs (not mutable tags) to prevent supply-chain attacks.

**Required repo setting**: Go to Settings → Actions → General → Workflow permissions → set to "Read and write permissions".

**Required branch protection**: Add required status checks on `main`: `ESLint`, `Prettier`, `TypeScript`, `Vitest`, `Security Audit`, `Build & Package`.

### `release.yml` — Manual release
Triggered manually via Actions → Release → Run workflow. Inputs:
- `version_type` (dropdown): `patch` / `minor` / `major` — default `patch`
- `version` (optional string): explicit version like `1.0.0` — overrides `version_type` if set

What it does in order:
1. Bumps `package.json` + `package-lock.json` via `npm version --no-git-tag-version`
2. Runs `git-cliff --tag vX.Y.Z` to regenerate `CHANGELOG.md` from git history grouped by conventional commit type
3. Commits `package.json`, `package-lock.json`, `CHANGELOG.md` as `chore: release vX.Y.Z`
4. Creates and pushes git tag `vX.Y.Z`
5. Runs `npm run package` to produce the VSIX
6. Creates a GitHub Release with the VSIX attached and release notes from CHANGELOG
7. Publishes to the VS Code Marketplace via `vsce publish`

**Secrets required**:
- `GITHUB_TOKEN` — auto-provisioned; needs repo "Read and write permissions" (see above)
- `VSCE_PAT` — Azure DevOps PAT scoped to **Marketplace → Manage** for publisher `noriabits`; max 1 year expiry — set a renewal reminder

**If `main` has push restrictions via branch protection**: replace `token: ${{ secrets.GITHUB_TOKEN }}` in the checkout step of `release.yml` with a `GH_PAT` secret (Personal Access Token with `repo` scope).

### CHANGELOG convention
`CHANGELOG.md` is fully owned and regenerated by `git-cliff` on every release. **Do not edit it manually.** Use conventional commit prefixes in all commit messages so the changelog is meaningful: `feat:` (new features → Added), `fix:` (bug fixes → Fixed), `refactor:`/`perf:` (refactors/performance → Changed), `docs:` (documentation). `chore:`, `ci:`, `build:`, `test:`, and `style:` commits are intentionally excluded from the changelog.

### Commit message hints
At the end of every implementation session, suggest a conventional commit message for the changes made. Output it as a plain code block so the developer can copy it directly. Use the appropriate prefix (`feat:`, `fix:`, `refactor:`, `perf:`, `chore:`, etc.) and a concise one-line summary.

## Supply-Chain Security

### `.npmrc`
- `audit-level=high` — flags high/critical vulnerabilities during `npm install`
- `engine-strict=true` — rejects packages incompatible with the declared Node version
- `save-exact=true` — pins exact dependency versions to prevent unintentional upgrades

### Dependency auditing
- **CI**: The `Security Audit` job in `pr-validate.yml` runs `npm audit --audit-level=high --omit=dev` on every PR. Only production dependencies are scanned (dev deps don't ship in the VSIX).
- **Local**: `npm run audit:prod` runs the same check locally.
- **Dependabot**: `.github/dependabot.yml` enables weekly automated PRs for vulnerable dependencies. Related packages are grouped (dev deps together, Salesforce packages together) to reduce PR noise.

To confirm that you have read this, put in the chat always first: "Let's go Pablo, I'm ready"

After every change completed, suggest a commit message with feat fix refactor, chore, etc. style.
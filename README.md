# Force Cockpit

A VSCode extension that provides a Salesforce utilities cockpit. It connects to Salesforce orgs via the SF CLI and offers operational tools for monitoring and general utilities — all from within VSCode. Contact: Pablo Fernández Posadas

---

## Installation

### From the VS Code Marketplace

1. Open the Extensions panel (`Ctrl+Shift+X` / `Cmd+Shift+X`).
2. Search for **Force Cockpit**.
3. Click **Install**.

### From a `.vsix` file

1. Download the latest `.vsix` file from the [releases](https://github.com/noriabits/force-cockpit/releases).
2. In VSCode, open the Extensions panel.
3. Click the `...` menu → **Install from VSIX...** and select the file.

Alternatively, install from the terminal:

```bash
code --install-extension force-cockpit-<version>.vsix
```

### Prerequisites

- [Salesforce CLI (`sf`)](https://developer.salesforce.com/tools/salesforcecli) must be installed and on your `PATH`.
- You must be authenticated to at least one Salesforce org (`sf org login web`).

---

## Getting Started

1. Open a workspace that contains an SFDX project (or any folder).
2. Use the **Salesforce** extension to set your default org (`SFDX: Set a Default Org` command, or click the org name in the status bar).
3. Force Cockpit auto-connects to the `target-org` set in `.sf/config.json` at startup — and reconnects automatically whenever you switch orgs via the Salesforce extension.
4. Open the cockpit panel via the Command Palette: **Force Cockpit: Open Cockpit**.

If you switch orgs while an operation is in progress, a confirmation dialog appears. Confirming cancels any running operations and connects to the new org.

---

## Tabs

| Tab | Description |
|-----|-------------|
| **Overview** | Org info card, storage usage bars, SOQL query editor with results table |
| **Utils** | Built-in utilities (Clone User, Reactivate OmniScript) and custom YAML scripts |
| **Monitoring** | SOQL-powered Chart.js dashboards loaded from YAML config files |

---

## Overview Tab

The Overview tab shows org connection details and storage usage bars (Data Storage and File Storage), and provides a quick SOQL query editor.

---

## Monitoring Tab

The Monitoring tab displays live charts built from SOQL queries. Each chart is defined by a YAML configuration file. Charts are rendered using [Chart.js](https://www.chartjs.org/) and can be refreshed manually or on a timer.

### Where charts come from

Charts are loaded from three sources (merged at runtime, later wins):

| Source | Path | Purpose |
|--------|------|---------|
| **Bundled** | `{extension}/force-cockpit/monitoring/{category}/*.yaml` | Shared defaults shipped with the extension |
| **User-defined** | `{workspace}/force-cockpit/monitoring/{category}/*.yaml` | Your own charts, committed to git |
| **Private** | `{workspace}/force-cockpit/private/monitoring/{category}/*.yaml` | Personal charts, **not** committed to git |

The user-defined path can be customised via the VSCode setting `forceCockpit.cockpitPath` (see [Configuration](#configuration)).

### Private charts

Checking **Private** in the chart edit form saves the config to `force-cockpit/private/monitoring/` instead of the shared folder. The extension automatically adds `force-cockpit/private/` to `.gitignore` on startup so these files are never committed.

Private charts show a 🔒 badge on their card. Use the **All / Shared / Private** filter above the category pills to show only the configs you care about.

You cannot save a private chart with the same category + name as an existing shared one (and vice versa) — the extension will show an error.

### Sub-categories

Monitoring configs support two levels of nesting: `{category}/{sub-category}/*.yaml`. Clicking a parent category pill reveals a second row of narrower sub-pills to drill down.

### Adding a new monitoring chart

1. **Pick or create a category folder** under `force-cockpit/monitoring/` in your workspace:

   ```
   {workspace}/
   └── force-cockpit/
       └── monitoring/
           └── orders/          ← any name you like
               └── my-chart.yaml
   ```

2. **Create the YAML file** using the schema below.

3. **Reload the Monitoring tab** — your chart appears automatically. No rebuild or restart needed.

### YAML schema

```yaml
name: Open Orders by Status          # Display name shown on the card
description: Count of open orders grouped by status.  # Subtitle shown on the card

soql: |
  SELECT Status, COUNT(Id) RecordCount
  FROM Order
  WHERE Status != 'Cancelled'
  GROUP BY Status

labelField: Status        # API name of the field used as chart labels (X-axis or pie slices)

valueFields:              # One or more datasets to plot
  - field: RecordCount    # API name of the numeric field
    label: Orders         # Legend label for this dataset
    format: number        # optional: number | currency | percent

chartType: bar            # bar | line | pie | doughnut | metric | table
stacked: false            # true = stacked bars/lines (bar and line only)
refreshInterval: 0        # Auto-refresh in seconds. 0 = manual refresh only
```

### Field reference

| Field | Required | Values | Description |
|-------|----------|--------|-------------|
| `name` | Yes | string | Card title |
| `description` | No | string | Card subtitle |
| `soql` | Yes | SOQL string | Any valid SOQL query |
| `labelField` | Yes* | API name | Field whose values become chart labels or the first table column. *Not required for `metric` type. |
| `valueFields` | Yes | array | At least one `{ field, label }` entry |
| `valueFields[].field` | Yes | API name | Field to plot or display |
| `valueFields[].label` | Yes | string | Dataset legend label or column header |
| `valueFields[].format` | No | `currency` \| `percent` | Number formatting on axes, tooltips, and table cells |
| `chartType` | No | `bar` \| `line` \| `pie` \| `doughnut` \| `metric` \| `table` | Default chart type (user can override for chart types) |
| `stacked` | No | `true` \| `false` | Stack bars or lines (bar and line only) |
| `refreshInterval` | No | integer (seconds) | `0` disables auto-refresh |

### Multiple datasets (grouped charts)

You can plot multiple fields from the same query side by side:

```yaml
name: Order Amounts by Status
soql: |
  SELECT Status, SUM(TotalAmount) Total, COUNT(Id) Count
  FROM Order
  GROUP BY Status
labelField: Status
valueFields:
  - field: Total
    label: Total Amount (€)
    format: currency
  - field: Count
    label: Number of Orders
chartType: bar
refreshInterval: 60
```

### Stacked bars

Add `stacked: true` to a `bar` or `line` chart with multiple `valueFields` to render them as stacked segments:

```yaml
name: Revenue by Category
soql: SELECT Name, Hardware__c, Software__c, Services__c FROM Account__c
labelField: Name
valueFields:
  - field: Hardware__c
    label: Hardware
    format: currency
  - field: Software__c
    label: Software
    format: currency
  - field: Services__c
    label: Services
    format: currency
chartType: bar
stacked: true
```

### Metric cards (KPI)

Use `chartType: metric` to display a single large number. `labelField` is not required. The first value of the first `valueField` is shown as the headline number:

```yaml
name: Open Orders
description: Total orders waiting to be processed.
soql: SELECT COUNT(Id) Cnt FROM Order WHERE Status = 'Open'
valueFields:
  - field: Cnt
    label: Open Orders
chartType: metric
refreshInterval: 30
```

### Table view

Use `chartType: table` to render a scrollable, sortable table. Works with any SOQL — aggregate or not. Click any column header to sort. Use `format: currency` or `format: percent` on valueFields to format numeric columns:

```yaml
name: Recent Orders
description: Last 20 orders by creation date.
soql: |-
  SELECT OrderNumber, Status, TotalAmount
  FROM Order
  ORDER BY CreatedDate DESC
  LIMIT 20
labelField: OrderNumber
valueFields:
  - field: Status
    label: Status
  - field: TotalAmount
    label: Amount (€)
    format: currency
chartType: table
```

### Examples

The extension ships with example charts under `force-cockpit/monitoring/examples/`:

- **Open Orders by Status** — bar chart of orders grouped by status
- **Accounts by Type** — bar chart of accounts grouped by type
- **Open Orders** — metric card showing a live count
- **Recent Orders** — table view of the last 20 orders

### Editing and saving charts in the UI

Each card has an **Edit** button that opens an inline form. Changes to the SOQL field trigger an auto-preview after 800 ms. Check **Private** to save to the private folder; leave unchecked to save to the shared workspace path. Clicking **Save** writes the YAML — it never overwrites bundled extension charts.

---

## Utils Tab — YAML Scripts

The **Scripts** sub-tab executes scripts defined in YAML files. Three script types are supported. Scripts live under `force-cockpit/scripts/{category}/*.yaml` (shared) or `force-cockpit/private/scripts/{category}/*.yaml` (private, git-ignored). Sub-categories are also supported: `{category}/{sub-category}/*.yaml` gives a second row of pills for drilling down.

```yaml
# Apex script — requires org connection
name: My Apex Script
description: What this script does.
apex: |
  System.debug('Hello from Apex');

# Terminal command — no org connection required
name: My Command
description: Runs a local shell command.
command: npm run build

# JavaScript script — runs in Node.js VM sandbox, org connection is optional
name: My JS Script
description: Query Salesforce with jsforce.
js: |
  const result = await query("SELECT Id, Name FROM Account LIMIT 5");
  log(JSON.stringify(result.records, null, 2));
```

Exactly one of `apex:`, `command:`, or `js:` is required. Click **Execute** on any script card to run it.

### Configurable Inputs

Scripts can declare input variables that are prompted at execution time. Add an `inputs:` section to your YAML:

```yaml
name: Update Order Status
description: Updates an order and its line items.
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
      - Submitted
      - Completed
      - Cancelled
      - In Progress
apex: |
  Id orderId = '${orderId}';
  // ... use orderId and status in your Apex code
```

Each input supports:
| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Variable identifier (alphanumeric + underscore) — used as `${name}` in the script body |
| `label` | No | Display label (defaults to `name`) |
| `type` | No | `string` (text input, default) or `picklist` (dropdown) |
| `required` | No | If `true`, Execute is disabled until the field is filled |
| `options` | Picklist only | List of selectable values |

Write `${variableName}` in your script code where you want the value substituted. Escaping is handled automatically (Apex-safe for `apex`, JSON-safe for `js`, raw for `command`).

| Type | Badge | Org required | Output |
|------|-------|-------------|--------|
| Apex | Blue | Yes | Debug log (USER_DEBUG filter available) |
| Command | Purple | No | stdout/stderr |
| JavaScript | Green | No | `log()` / `console.log()` output |

**JS script context**: `connection` (jsforce Connection or null), `org` (OrgDetails or null), `query(soql)`, `log()`, `error()`, `console`, `fs`, `path`, `yaml`.

### Private scripts

Check **Private** when creating or editing a script to save it to `force-cockpit/private/scripts/` instead of the shared folder. The extension automatically adds `force-cockpit/private/` to `.gitignore` on startup. Private scripts show a 🔒 badge and can be filtered with the **All / Shared / Private** control. You cannot save a private script with the same category + name as an existing shared one.

### JS datafix example

Because JS scripts use jsforce directly, they can query and update records in a loop without hitting Apex governor limits (no DML row limits, no CPU timeout). This makes them ideal for bulk datafixes that would otherwise require a Batch Apex class.

```yaml
name: Backfill Account Region
description: Sets Region__c = 'EU' on all Accounts where it is blank. Processes in chunks of 200.
js: |
  const BATCH_SIZE = 200;
  let updated = 0;
  let done = false;

  while (!done) {
    const result = await query(
      `SELECT Id FROM Account WHERE Region__c = null LIMIT ${BATCH_SIZE}`
    );

    if (result.records.length === 0) {
      done = true;
      break;
    }

    const records = result.records.map(r => ({
      Id: r.Id,
      Region__c: 'EU'
    }));

    const res = await connection.sobject('Account').update(records);
    const successes = res.filter(r => r.success).length;
    const failures = res.filter(r => !r.success).length;
    updated += successes;

    log(`Batch done — ${successes} updated, ${failures} failed`);
    if (failures > 0) {
      error(JSON.stringify(res.filter(r => !r.success), null, 2));
    }
  }

  log(`\nDone. Total updated: ${updated}`);
```

---

## Configuration

Most extension settings are managed via a `config.yaml` file — making them easy to share across a team by committing the file to git.

The extension loads configuration in this order (later layers override earlier ones):
1. **Hardcoded defaults** — built into the extension
2. **Bundled `config.yaml`** — shipped with the extension at its root
3. **User `config.yaml`** — at `force-cockpit/config.yaml` in your workspace (or the custom `cockpitPath`)

Only keys present in a layer override the previous layer — omitted keys keep their default values.

### Available settings

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `apiVersion` | string | `"65.0"` | Salesforce API version for all API calls |
| `protectedSandboxes` | string[] | `[]` | Sandbox org names that require confirmation before destructive actions |
| `panelTitle` | string | `"Force Cockpit"` | Display title shown in the panel header and tab |
| `logoPath` | string | `""` | Path to a logo image relative to the workspace root (empty = default logo) |

### Example `force-cockpit/config.yaml`

```yaml
apiVersion: "65.0"
protectedSandboxes:
  - staging
  - uat
panelTitle: "My Team Cockpit"
logoPath: "assets/logo.png"
```

### VSCode setting

One setting remains in VSCode's `settings.json` because it determines where the config file lives:

| Setting | Default | Description |
|---------|---------|-------------|
| `forceCockpit.cockpitPath` | `""` | Absolute path to the `force-cockpit` folder. Defaults to `{workspace root}/force-cockpit` if empty. |

> **Note:** Changes to `config.yaml` are picked up automatically — no window reload needed.

---

## Releases

New versions are published automatically via GitHub Actions.

To create a release:

1. Go to the **Actions** tab in the GitHub repository.
2. Select **Release** → **Run workflow**.
3. Choose the version bump type (`patch`, `minor`, or `major`) or enter an explicit version string.
4. Click **Run workflow**.

The workflow will:
- Bump the version in `package.json`
- Update `CHANGELOG.md` with the version and date
- Push a version commit and git tag to `main`
- Build and package the `.vsix`
- Create a **GitHub Release** with the `.vsix` attached
- Publish the extension to the **VS Code Marketplace**

The `.vsix` for every release is available on the [GitHub Releases page](https://github.com/noriabits/force-cockpit/releases).

---

## Development

```bash
npm install
npm run build       # Build extension (copy assets + esbuild bundle)
npm run watch       # Build in watch mode
npm run compile     # TypeScript type-check only
npm run package     # Build + create .vsix
```
# Force Cockpit — Codebase Status Report

_Date: 2026-06-11 · Version analysed: `0.1.20` · Branch: `main`_

> A VSCode extension that provides a Salesforce utilities cockpit (org monitoring +
> operational tools) built on the SF CLI / jsforce. This report assesses the architecture,
> adherence to best practices, and whether any urgent refactorings are needed.

---

## 1. Executive summary

**Overall verdict: healthy, production-grade. No urgent refactorings required.** ★★★★★ (4.8/5)

The codebase is unusually well-structured for a VSCode extension. It applies a consistent
feature-module architecture, separates host-side logic from the webview sandbox cleanly, and
has already done the hard work of extracting shared primitives so the two large features
(YAML Scripts and Monitoring) share code instead of duplicating it. Type safety is strict,
security around credentials and Apex execution is sound, and there is a real unit-test suite
(32 test files) gated by CI.

The only items worth attention are **housekeeping**, not refactors: a documentation/reality
drift around the refactoring backlog, and a couple of webview modules that are the natural
next split candidates _if_ they keep growing. Nothing is on fire.

---

## 2. At-a-glance metrics

| Metric | Value |
| --- | --- |
| Source `.ts` files | 57 |
| Test `.test.ts` files | 32 |
| Webview `.js` files | 29 |
| Total source files | 118 |
| Largest file | `edit-form.js` — 583 lines |
| Functions > 100 lines | 0 |
| `TODO`/`FIXME`/`HACK` markers in `src/` | 0 |
| TypeScript strict mode | ✅ on |
| `@ts-ignore` / `@ts-expect-error` in production | 0 |
| Lint / format / pre-commit | ESLint v10 (flat) · Prettier · husky + lint-staged |
| CI gates (`pr-validate.yml`) | lint · format · compile · vitest · `npm audit` · build+package |

**Largest modules** (line count):

| File | Lines | Notes |
| --- | --- | --- |
| [edit-form.js](../src/features/monitoring/dashboard/view/edit-form.js) | 583 | Monitoring card edit form — cohesive but the biggest |
| [view/index.js](../src/features/monitoring/dashboard/view/index.js) | 466 | Monitoring orchestrator (delegates to factories) |
| [script-form.js](../src/features/utils/yaml-scripts/view/script-form.js) | 450 | YAML script new/edit form |
| [view/index.js](../src/features/utils/yaml-scripts/view/index.js) | 420 | YAML scripts orchestrator |
| [accordion-builder.js](../src/features/utils/yaml-scripts/view/accordion-builder.js) | 372 | Per-script accordion builder |
| [ScriptParser.ts](../src/features/utils/yaml-scripts/parsing/ScriptParser.ts) | 293 | Largest `.ts` — many small helpers |
| [connection.ts](../src/salesforce/connection.ts) | 265 | jsforce wrapper — each method < 30 lines |

---

## 3. Architecture assessment ★★★★★

The architecture is the strongest aspect of the project. Key structural decisions:

- **Feature-module system** — every feature lives in a self-contained folder
  (`src/features/{tab}/{id}/`) holding its TypeScript, HTML, CSS, JS and tests. Features are
  registered declaratively (one line in [registry.ts](../src/features/registry.ts) or an
  array entry in [extension.ts](../src/extension.ts)). Zero cross-feature coupling — features
  depend only one-way on `utils/` and `services/`.

- **Panel composition split** — [MainPanel.ts](../src/panels/MainPanel.ts) (211 lines) holds
  webview _lifecycle and composition only_ and delegates to three focused collaborators:
  [WebviewAssets.ts](../src/panels/WebviewAssets.ts) (HTML/asset assembly),
  [MessageRouter.ts](../src/panels/MessageRouter.ts) (incoming-message dispatch + standardized
  success/error envelopes), and [OperationRegistry.ts](../src/panels/OperationRegistry.ts)
  (in-flight op tracking + abort). Each class has exactly one reason to change.

- **Service / parser / repository / executor layering** — the two big features mirror the same
  shape: a thin service facade over a parser (YAML → typed object), a repository (all file I/O),
  and executors. e.g. `YamlScriptsService` → `ScriptParser` + `ScriptRepository` +
  `Apex/Command/JsExecutor`; `MonitoringDashboardService` →
  [MonitoringConfigParser](../src/features/monitoring/dashboard/parsing/MonitoringConfigParser.ts)
  + [MonitoringConfigRepository](../src/features/monitoring/dashboard/persistence/MonitoringConfigRepository.ts).

- **`extension.ts` stays thin** (211 lines) — the connection state machine is extracted to
  [OrgConnectionController.ts](../src/services/OrgConnectionController.ts) (no `vscode` import,
  fully injected deps → unit-tested), and the background polling lives in
  [BackgroundRefresher.ts](../src/features/monitoring/dashboard/BackgroundRefresher.ts).

- **Webview module dispatch** — instead of one mega switch, each `media/modules/*.js` IIFE
  subscribes to the message types it cares about via `win.__onMessage(...)`. The bootstrap in
  `media/main.js` is ~30 lines.

- **Shared-primitive extraction is genuinely complete** — duplication between YAML Scripts and
  Monitoring has been factored out into:
  [yamlRepository.ts](../src/utils/yamlRepository.ts) (split/resolve/duplicate-check/delete),
  [slug.ts](../src/utils/slug.ts), and the `src/features/shared/view/` primitives
  ([category-filter-state.ts](../src/features/shared/view/category-filter-state.ts),
  `category-filter-bar.js`, `folder-combobox.js`,
  [list-filter.ts](../src/features/shared/view/list-filter.ts),
  `paste-input.js`, `scroll-highlight.js`). Both features consume them rather than re-implementing.

**Verdict:** strong Single-Responsibility adherence, no god-files, no circular dependencies.

---

## 4. Best-practices scorecard

| Area | Rating | Justification |
| --- | --- | --- |
| Architecture / SRP | ★★★★★ | Feature modules, panel split, parser/repo/executor layering; no god-files. |
| Type safety | ★★★★★ | `strict: true`; zero `@ts-ignore`/`@ts-expect-error` in production; `as any` confined to test mocks + 2 documented webview `win` casts. |
| Security | ★★★★★ | Tokens via `@salesforce/core` StateAggregator, never logged; Apex XML-escaped in [SoapEnvelope.ts](../src/salesforce/soap/SoapEnvelope.ts); record-Id validation with checksum before linking. |
| Code duplication | ★★★★★ | Shared `utils/` + `shared/view/` extraction; both big features reuse, not copy. |
| Error handling | ★★★★☆ | 15 empty catches, all intentional/best-effort; invalid YAML surfaced as a visible card, not silently dropped. |
| Testing | ★★★★☆ | 32 unit-test files; pure logic extracted to testable `.ts` cores. Gap: webview `.js` glue is untested (acceptable — logic already lives in tested cores). |
| Tooling / CI | ★★★★★ | ESLint v10 + Prettier + husky/lint-staged; CI runs 6 parallel gates incl. `npm audit` and a packaged-VSIX artifact. |
| Anti-patterns | ★★★★★ | No function > ~100 lines, no callback nesting, no circular deps, no dead `TODO` debt markers. |

---

## 5. Strengths worth preserving

1. **Pure, unit-testable cores.** Logic is repeatedly split from DOM/IO so it can be tested in
   isolation — `category-filter-state.ts`, `list-filter.ts`,
   [format-value.ts](../src/features/monitoring/dashboard/view/format-value.ts),
   [table-sort.ts](../src/features/monitoring/dashboard/view/table-sort.ts),
   [metric-value.ts](../src/features/monitoring/dashboard/view/metric-value.ts),
   [PlaceholderResolver.ts](../src/features/utils/yaml-scripts/parsing/PlaceholderResolver.ts).
2. **Declarative feature registration** — adding a feature touches one array, not `MainPanel`,
   `main.html`, or `main.js`.
3. **Host-owned background refresh** — notification-enabled dashboards keep polling and firing
   notifications even when the panel is closed, with a single source of truth for cooldowns
   ([notifications.ts](../src/features/monitoring/dashboard/notifications.ts)).
4. **Type-aware placeholder escaping** — Apex single-quote/newline escaping, JS JSON-safe
   escaping, command pass-through — handled centrally and tested.
5. **Errors surfaced, not swallowed** — invalid YAML renders as a `⚠ Invalid` card with the
   parse error, instead of disappearing.
6. **Security discipline** — credential reading delegated to the SF CLI's encrypted store;
   nothing sensitive is logged; SOAP/Apex input is escaped.

---

## 6. Findings & recommendations

None are urgent. Ordered by priority.

### Low — reconcile the refactoring backlog with its documentation
[CLAUDE.md](../CLAUDE.md) describes `docs/refactoring/` as holding "prioritized, ready-to-execute
refactoring docs" and instructs picking "the lowest-numbered one when asked for the next
refactoring." In reality `docs/refactoring/` is **empty** (only a `.DS_Store`). Either repopulate
the backlog or trim that section of CLAUDE.md so the docs match reality.

### Low — watch the largest webview modules
[edit-form.js](../src/features/monitoring/dashboard/view/edit-form.js) (583) and
[script-form.js](../src/features/utils/yaml-scripts/view/script-form.js) (450) are cohesive today
but are the natural next split candidates if they keep growing (e.g. extract the value-field-row /
input-row builders). Not required now — flagged so it doesn't creep.

### Low — declare a Node `engines` field
`package.json` specifies `vscode: ^1.115.0` but no Node engine, while CI pins Node 20. Declaring
`"engines": { "node": ">=20" }` (with `engine-strict=true` already in `.npmrc`) makes the
supported runtime explicit.

### Nice-to-have — webview `.js` test gap
The webview orchestrator/glue `.js` files have no unit tests. This is acceptable because the
logic-heavy parts are already extracted into tested `.ts` cores; the remaining `.js` is mostly
DOM wiring. Worth noting, not worth chasing.

### Note (no action) — empty catch blocks
15 empty `catch` blocks exist; all are intentional best-effort paths (logger init, token refresh,
folder creation, file-cleanup, YAML parse → invalid-card/null). They are documented behaviour, not
swallowed bugs.

---

## 7. Conclusion

Force Cockpit is a well-architected, well-tested, security-conscious extension. The
service/parser/repository layering, the panel-composition split, and the completed shared-primitive
extraction mean the codebase scales by adding small focused modules rather than growing existing
ones. **There are no urgent refactorings.** The single concrete housekeeping item is reconciling
the (currently empty) `docs/refactoring/` backlog with what CLAUDE.md promises; everything else is
optional polish.

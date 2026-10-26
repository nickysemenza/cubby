# Fast native iteration

Pick the smallest loop that can show the behavior you changed. Keep the simulator
booted and the relevant build artifacts warm while working on one feature.

| Change or question                                                     | First loop                                                                                         | What it exercises                                                                                                         |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Pure `CubbyKit` logic, parsing, patching, or state                     | Run a focused Swift test with `swift test --package-path apps/apple/CubbyKit --filter <test-name>` | The real package code on macOS; no server or simulator.                                                                   |
| An ad hoc native API or local-file question                            | `pnpm apple cli <command>`                                                                         | A small `CubbyKit` executable, without building or launching the app. Use `pnpm apple cli --help` to see commands.        |
| Native API/auth/search/edit behavior                                   | `pnpm test:e2e:sim -- --headless`                                                                  | The `cubby` CLI against workerd and a disposable seeded database. It does not run `AppModel`, navigation, or SwiftUI.     |
| One SwiftUI screen or state                                            | Render that file's `#Preview` with Xcode MCP `RenderPreview`                                       | The view with synthetic, in-memory `PreviewFixtures`; no server or login. Inspect the returned PNG in Codex.              |
| App model or navigation logic                                          | Xcode MCP `RunSomeTests` for a focused app test                                                    | App-target code that the `CubbyKit` package tests and headless CLI do not compile or execute.                             |
| Simulator UI behavior against real API data                            | `pnpm test:e2e:sim`                                                                                | Debug iOS app, real auth, workerd, synthetic seed, and visible search/detail identity.                                    |
| Taps, navigation, sheets, keyboard, or accessibility                   | Use Xcode MCP device interaction or `agent-device` on an already installed simulator app           | The running app and its UI tree. Use `pnpm apple sim` to rebuild and install after code changes.                          |
| Search/detail smoke against a fresh database                           | `pnpm test:e2e:sim`                                                                                | Debug iOS app, real auth, workerd, synthetic seed, and visible search/detail identity. Headless covers client writes.     |
| A reviewable recording of that journey                                 | `pnpm test:e2e:sim -- --video`                                                                     | The same flow plus `run.mp4` and a timestamped `contact-sheet.png` under `artifacts/sim-e2e/`. Open either file in Codex. |
| Device-only behavior (camera, permissions, performance, installed app) | `pnpm apple ios` on a paired iPhone                                                                | Real device behavior; use Xcode/agent-device for interaction and diagnostics.                                             |
| Mac-specific UI                                                        | `pnpm apple mac` and Mac previews/tests                                                            | The native macOS shell and window behavior.                                                                               |

Run `pnpm test:e2e:sim -- --headless` for native JSON client writes
against the disposable Worker. Use
`pnpm test:e2e:sim -- --headless --photo --purchase` or
`pnpm test:e2e:local -- headless:wardrobe` for the composed photo, retailer,
and normalized statement workflow. Statement evidence is recorded through
`sourceTransactionRecord.record`; reviewed transaction kinds are explicit kernel creates.
The wardrobe journey checks exact replay, overlapping evidence, decoy charges,
reviewed settlement, and preservation of Expense and inventory during convergence.

`pnpm test:e2e:sim -- --qa-photo-completion` checks that approving the final selected
ready group of a stopped `needs_review` photo Run updates the same open console’s
hero and Progress report to completed without manual refresh. The fixture is synthetic;
the runner reads the completed Run and committed proposal back and saves checksummed
evidence through the usual QA artifact path. This guard also runs in the full QA lane.

`pnpm test:e2e:sim -- --qa` seeds the shared connected exploration household
(`tooling/scenarios/corpus.ts`, also used by dev and browser screenshots), adds
journey-specific fixtures (`tooling/scenarios/native-qa.ts`), and replays
every `apps/apple/e2e/qa-*.ad` journey against it: hero Discard with a shelf choice, statement match
save, approving only the selected ready group of a photo Run, a structured
unit-mapping edit, external-ID Source/Identifier keyboard entry on an independent
Product, and formatted barcode Add, additive preservation, explicit primary
promotion and secondary-barcode sweep confirmation,
recipe scaling in cook mode, and scoped entity picking after a location change
with selections across two pages. After the replays it reads the database back
(one unit from the chosen shelf only, both allocations, the one committed
photo group and its Product, and exactly the selected location and two plantings) before writing the usual checksummed bundle under `artifacts/sim-qa-e2e/`. Add
`--hold` to skip the scripted journeys and keep the server and simulator up after seeding
(ids in `qa-ids.json`; `touch qa.stop` ends it) for manual driving. A held session is not
a passing journey. Scroll to a target by counting from `scroll bottom`, not with
`--until` on a lazily loaded detail page.

`pnpm test:e2e:sim -- --qa --journey qa-derived-explanation` checks that a Product
row menu retains both Explain and Use inherited, opens the published/live
comparison, and closes back to the same record without applying an override.

`pnpm test:e2e:sim -- --qa --journey qa-run-evidence` checks the sole hosted
Run evidence sheet against the synthetic approval Run: enter from the native
Runs catalog, load its durable operation and structured log, confirm that the
native loading/error overlays are absent, dismiss the sheet, reopen and load
it again. Each Done must remove the hosted transcript from the accessibility tree.
The return check reopens the native evidence item from the detail More menu, since Run has no edit action.
This journey does not establish Retry, logout, host switching, auth/update gates,
or record handoff and refresh acceptance.

`pnpm test:e2e:sim -- --qa --journey qa-entity-table --video` checks the generic
Product List/Table switch, sortable headers, column visibility, and record
navigation against the same synthetic QA world. The focused sort-model tests
cover paging and pending-search response fencing; the simulator journey covers
the controls and navigation boundary. Its evidence uses the usual checksummed
QA artifact bundle.

Reach catalog targets with `scroll down 0.5 --until "id=…"` using the current
shared driver, whose scroll command repeats passes until the target is visible.
Avoid fixed swipe counts: compact row changes can overshoot the intended entity.
If the driver reports no progress, inspect the current tree and scroll surface
before adding another swipe. An identifier may be
shared by its row and child nodes, so narrow catalog clicks with the entity
label. Inspect the current accessibility tree before adding role constraints:
iOS View choices are cells, column toggles and table headers are buttons, and
the Columns control is a popup button. Use visible labels for menu choices.
Assert table rows, headers, and
visible totals rather than an unexposed layout container; the Columns popup
is observable by its accessibility label.
After opening a record, assert its detail Edit control. A title-only assertion
can pass while the list stays visible behind a field explanation.
Generic editor inputs use `editor.<entity>.<field>` accessibility identifiers.
Keep that identity on the input itself: text width and keyboard avoidance can
change its frame during entry, so frame-based identity cannot confirm replacement.

For Mac `TableColumn`, apply `width` before `customizationID`; the latter
returns opaque `TableColumnContent`, which has no `width` modifier. Validate
native column modifiers with the full Mac build, including sorted and plain
columns.

`pnpm test:e2e:sim -- --product-clarity --video` runs a focused synthetic Product
presentation journey. It opens and closes the valuation explanation, checks the
manual and expense-derived values, and verifies recorded movement, planned, and
explicit-link badges in both Product → Purchase and Purchase → Product navigation.
The existing disposable database, auth, build-provenance, and artifact bundle
paths apply. This lane launches the simulator app; run it after other native
UI automation has released the host.

`pnpm --dir apps/web exec tsx tooling/mac-import-e2e.ts --product-clarity`
checks the same synthetic valuation and financial relation evidence in the
actual sandboxed Mac fixture app, then switches to Table with multiple rows,
asserts ascending and descending Name order, scrolls through reused cells,
opens a table Quality explanation, shows and hides Brand values,
opens a category reference in the detail pane, and returns to List. Sorting must
retain the AppModel dependency of every field explanation cell. It uses the existing isolated signing,
verified process, disposable database, and checksummed artifact paths; an
unlocked Mac session with Accessibility permission is required. Run Mac and
simulator UI lanes sequentially.

Keep import workflow state in `CubbyKit`: transaction booking/correction review
and Run/photo review commands are shared with the
CLI. Matching, categorization, receipt expectations, and economic writes remain
backend operations. SwiftUI owns presentation, pickers,
confirmation dialogs, and navigation.

Use headless CLI journeys for import behavior and retry coverage. Keep Mac smoke
tests for file selection, navigation, sign-in controls, and review/save actions;
use the longer composed Mac journey when a change crosses those UI boundaries.
CLI/server workflows do not need an unlocked screen.

`pnpm test:e2e:sim -- --headless --photo` uploads through Swift, saves the shared
Run review, and approves those exact proposals through the CLI. It checks the
resulting Products and item/label attachments without launching a browser or app.
Web batch approval, image rendering, processing failures, and restart navigation
remain covered by `apps/web/tests/e2e/photo-group-review.spec.ts`.

## Recommended loop

Focused iOS app tests use the `Cubby-iOS` scheme, a concrete simulator destination,
and the build flags in `apps/apple/tooling/apple.ts` (launched by `apple-check.sh`). Swift Testing method selectors
include parentheses, for example
`'-only-testing:Cubby-iOS-Tests/LibraryMetadataSyncTests/bulkPagesAreBoundedAndSerialized()'`.
Check the executed test count: `TEST SUCCEEDED` with zero tests is not validation.
When only the selector changes, `test-without-building` reuses the existing test
bundles and DerivedData without compiling again.

1. Edit a `CubbyKit` algorithm or model and run its focused Swift test. For a
   networked native change, run the affected headless journey with
   `pnpm test:e2e:sim -- --headless` after batching related edits.
   Cargo and Swift use their standard incremental caches across runs.
2. Edit a SwiftUI view and render its nearest `#Preview` through Xcode MCP.
   Entity row previews need `SignedInPreview` even with plain-data fixtures:
   their lazy field explanations read `AppModel` from the environment.
   `PreviewFixtures` contain synthetic, wire-shaped states and intentionally
   block network reads. Add focused states such as empty, loading, error, dark,
   and large text when they expose the change. The generated fixture JSON comes
   from `pnpm generate`.
3. When the change needs real interactions, run the affected
   `pnpm test:e2e:sim` journey after batching related edits. Xcode and Swift use their standard incremental caches across runs.
4. Run the scripted simulator flow for a cross-layer journey. Add `--video` when
   a human should review the exact UI actions. The database is unique per run
   and dropped afterward; artifacts stay under `artifacts/sim-e2e/`.

For manual exploration with a stable corpus, start `pnpm dev`, then use
`pnpm dev sim --sim <name>`. The launcher discovers the session origin and
persists the app's development server choice. That database persists across
runs; see [local development](../../docs/local-development.md). The disposable headless and simulator lanes
have their own synthetic account and seed. SwiftUI previews use in-memory
fixtures, so editing the local database does not change a preview.

## Inspect simulator behavior

Use the session name, simulator UDID, and agent-device state directory printed
by the finite runner while it is active. For example:

```sh
pnpm exec agent-device snapshot -i --diff --platform ios --udid <udid> --session <session> --state-dir <state-dir>
pnpm exec agent-device screenshot --platform ios --udid <udid> --session <session> --state-dir <state-dir> --out /tmp/cubby-screen.png
pnpm exec agent-device logs path --platform ios --udid <udid> --session <session> --state-dir <state-dir>
```

Run
`test:e2e:sim -- --extended-journey` for native UI editing, view switching and
filter regressions; those interactions require that extended check.

A runner timeout while typing is not by itself evidence of a slow app: sample
both the app and the runner and check the runner's selected identifier
and `TEXT_ENTRY_PHASE` timings first. agent-device binds a coordinate-chosen
input by query index, which resolves to a different input once focusing scrolls
the form; the pinned patch re-queries the input by its accessibility identifier
instead. A focused input touching
the keyboard's prediction bar is a separate layout issue; successful automation
does not verify keyboard clearance.

Ctrl-C closes the runner's agent-device session and drops its database. The
detached watchdog drops that database if the runner is killed. Simulator runs
leave evidence under `artifacts/sim-e2e/<database>/`; use
`test:e2e:sim -- --video` when a reviewable MP4 and contact sheet are needed.

## Build reuse and a clean checkout

Every simulator lane, local or hosted, builds through the cached
`apple:simulator-build` Nx target (one simulator-generic profile in
`apps/apple/tooling/apple-check.sh`). A later lane, worktree restart, or disposable
simulator gets that app restored from the Nx cache, locally or from the shared
remote cache, when its inputs and Xcode version are unchanged. Its
`native-build` phase includes `pnpm apple gen`, so setup and scenario time
stay separate in `phases`.

Xcode resolves the app graph into the tracked `apps/apple/Package.resolved`,
linked into the generated project's workspace by `project.yml`. Without that
link Xcode wrote Nuke and Sentry into `CubbyKit/Package.resolved`, floated
their versions, and marked every native E2E bundle `dirty`. CubbyKit's
lockfile holds only its own pins and changes through `swift package update`;
an app package change shows up in `apps/apple/Package.resolved`.

`pnpm apple mac --replace-signing-identity` explicitly transitions an installed
TestFlight app to the development signing identity. Expect possible one-time
privacy reapproval. It retains team/bundle verification and app data, but skips
the old privacy requirement check for this invocation. Use plain `pnpm apple mac`
for subsequent installs to preserve the development identity.

`pnpm apple mac` builds and signs a Debug app, verifies its compatibility
version, installs it at `/Applications/Cubby.app`, and relaunches the installed
copy. It refuses built or existing installed apps that the project team did not
sign, or a candidate that does not satisfy the installed app's privacy
requirement. Staged verification precedes termination and replacement, with rollback
if replacement fails. A previous bundle that cannot be removed is retained
as a reported sibling backup; it does not prevent relaunch. macOS privacy grants (Photos) record
the approving app's designated requirement; an ad-hoc build from a
`CODE_SIGNING_ALLOWED=NO` command has a per-build requirement, so opening it
resets those grants and the next signed build asks again.

Mac fixture apps keep their stable Developer ID identity, and the presentation
accessibility helper runs from one stable signed cache path (its source,
compiler and signed bytes decide reuse), so a new run directory never creates a
new Accessibility identity. Archived helper copies are evidence, not
executables for driving the app.

`pnpm apple check` and the normal PR checks remain the broader validation
gates. The simulator flow is a targeted acceptance check for native UI
behavior, so it does not need to run on every edit.

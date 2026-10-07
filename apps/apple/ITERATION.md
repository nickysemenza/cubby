# Fast native iteration

Pick the smallest loop that can show the behavior you changed. Keep the simulator
booted and the relevant build artifacts warm while working on one feature.

| Change or question                                                     | First loop                                                                                         | What it exercises                                                                                                         |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Pure `CubbyKit` logic, parsing, patching, or state                     | Run a focused Swift test with `swift test --package-path apps/apple/CubbyKit --filter <test-name>` | The real package code on macOS; no server or simulator.                                                                   |
| An ad hoc native API or local-file question                            | `pnpm apple cli <command>`                                                                         | A small `CubbyKit` executable, without building or launching the app. Use `pnpm apple cli --help` to see commands.        |
| Native API/auth/search/edit behavior                                   | `pnpm test:e2e:sim -- --headless --watch`, then press Enter to rerun                               | The `cubby` CLI against workerd and a disposable seeded database. It does not run `AppModel`, navigation, or SwiftUI.     |
| One SwiftUI screen or state                                            | Render that file's `#Preview` with Xcode MCP `RenderPreview`                                       | The view with synthetic, in-memory `PreviewFixtures`; no server or login. Inspect the returned PNG in Codex.              |
| App model or navigation logic                                          | Xcode MCP `RunSomeTests` for a focused app test                                                    | App-target code that the `CubbyKit` package tests and headless CLI do not compile or execute.                             |
| Repeated simulator UI edits against real API data                      | `pnpm test:e2e:sim -- --watch`, then press Enter to replay                                         | One Debug app installation, workerd server, and disposable seeded database; a new product and database check each run.    |
| Taps, navigation, sheets, keyboard, or accessibility                   | Use Xcode MCP device interaction or `agent-device` on an already installed simulator app           | The running app and its UI tree. Use `pnpm apple sim` to rebuild and install after code changes.                          |
| A repeatable native user journey against a fresh database              | `pnpm test:e2e:sim`                                                                                | Debug iOS app, real auth, workerd, synthetic seed, agent-device assertions, and database readback.                        |
| A reviewable recording of that journey                                 | `pnpm test:e2e:sim -- --video`                                                                     | The same flow plus `run.mp4` and a timestamped `contact-sheet.png` under `artifacts/sim-e2e/`. Open either file in Codex. |
| Device-only behavior (camera, permissions, performance, installed app) | `pnpm apple ios` on a paired iPhone                                                                | Real device behavior; use Xcode/agent-device for interaction and diagnostics.                                             |
| Mac-specific UI                                                        | `pnpm apple mac` and Mac previews/tests                                                            | The native macOS shell and window behavior.                                                                               |

Run `pnpm test:e2e:sim -- --headless --statement-csv` for Swift CSV file preview
and reviewed import through generated OpenAPI calls. The disposable Worker
journey checks physical occurrences, exact retry, ambiguous date matches,
canonical charge preservation, and no implicit Expense or stock creation. Its
shared booking session also previews without writes, commits the saved review,
and replays it without duplicating economics. Run this lane directly or with
`pnpm test:e2e:local -- headless:statement-csv`. Its
sanitized results and replay command are checksummed under
`artifacts/headless-e2e/statement-csv/`.

`pnpm test:e2e:sim -- --qa-photo-completion` checks that approving the final selected
ready group of a stopped `needs_review` photo Run updates the same open console’s
hero and Progress report to completed without manual refresh. The fixture is synthetic;
the runner reads the completed Run and committed proposal back and saves checksummed
evidence through the usual QA artifact path. This guard also runs in the full QA lane.

`pnpm test:e2e:sim -- --qa` seeds a synthetic household (`tooling/scenarios/native-qa.ts`) and replays
every `apps/apple/e2e/qa-*.ad` journey against it: hero Discard with a shelf choice, statement match
save, Run approval, approving only the selected ready group of a photo Run, a structured
unit-mapping edit, recipe scaling in cook mode, and scoped entity picking after a location change
with selections across two pages. After the replays it reads the database back
(one unit from the chosen shelf only, both allocations, the granted approval, the one committed
photo group and its Product, and exactly the selected location and two plantings) before writing the usual checksummed bundle under `artifacts/sim-qa-e2e/`. Add
`--hold` to keep the server and simulator up after seeding (ids in `qa-ids.json`; `touch qa.stop`
ends it) for manual driving. Scroll to a target by counting from `scroll bottom`, not with
`--until` on a lazily loaded detail page.

`pnpm test:e2e:sim -- --qa --journey qa-entity-table --video` checks the generic
Product List/Table switch, sortable headers, column visibility, and record
navigation against the same synthetic QA world. The focused sort-model tests
cover paging and pending-search response fencing; the simulator journey covers
the controls and navigation boundary. Its evidence uses the usual checksummed
QA artifact bundle.

`pnpm test:e2e:sim -- --product-clarity --video` runs a focused synthetic Product
presentation journey. It opens and closes the valuation explanation, checks the
manual and expense-derived values, and verifies recorded movement, planned, and
explicit-link badges in both Product → Purchase and Purchase → Product navigation.
The existing disposable database, auth, build-provenance, and artifact bundle
paths apply. This lane launches the simulator app; run it after other native
UI automation has released the host.

`pnpm --dir apps/web exec tsx tooling/mac-import-e2e.ts --product-clarity`
checks the same synthetic valuation and financial relation evidence in the
actual sandboxed Mac fixture app. It uses the existing isolated signing,
verified process, disposable database, and checksummed artifact paths; an
unlocked Mac session with Accessibility permission is required. Run Mac and
simulator UI lanes sequentially.

Keep import workflow state in `CubbyKit`: CSV preview and decisions, transaction
booking/correction review, Run/photo review commands, and the macOS browser bridge
are shared with the CLI. Matching, categorization, receipt expectations, and
economic writes remain backend operations. SwiftUI owns presentation, pickers,
confirmation dialogs, and navigation.

Use headless CLI journeys for import behavior and retry coverage. Keep Mac smoke
tests for file selection, navigation, sign-in controls, and review/save actions;
use the longer composed Mac journey when a change crosses those UI boundaries.
The browser CLI shares the real executor and bridge, but browser Apple Events
still need a permissioned graphical macOS session. CLI/server workflows do not
need an unlocked screen.

`pnpm test:e2e:sim -- --headless --photo` uploads through Swift, saves the shared
Run review, and approves those exact proposals through the CLI. It checks the
resulting Products and item/label attachments without launching a browser or app.
Web batch approval, image rendering, processing failures, and restart navigation
remain covered by `apps/web/tests/e2e/photo-group-review.spec.ts`.

## Recommended loop

1. Edit a `CubbyKit` algorithm or model and run its focused Swift test. For a
   networked native change, start `pnpm test:e2e:sim -- --headless --watch` once, then press
   Enter after each edit. The first run builds workerd and the CLI; later runs
   reuse the server and database, seed a new synthetic product, and rebuild the
   CLI only when Swift sources changed. Restart after web or Rust FFI changes.
2. Edit a SwiftUI view and render its nearest `#Preview` through Xcode MCP.
   `PreviewFixtures` contain synthetic, wire-shaped states and intentionally
   block network reads. Add focused states such as empty, loading, error, dark,
   and large text when they expose the change. The generated fixture JSON comes
   from `pnpm generate`.
3. When the change needs repeated real interactions, start `pnpm test:e2e:sim -- --watch`.
   The first run builds and installs the Debug app, then signs in and edits a
   synthetic product. Press Enter to seed another product and replay the shorter
   deep-link flow. It rebuilds and reinstalls only after Apple Swift sources or
   the Xcode project specification change. The printed agent-device session can
   be inspected interactively between runs. Restart watch after web server,
   generated API, or Rust FFI changes.
4. Run the scripted simulator flow for a cross-layer journey. Add `--video` when
   a human should review the exact UI actions. The database is unique per run
   and dropped afterward; artifacts stay under `artifacts/sim-e2e/`.

For manual exploration with a stable corpus, start `pnpm dev`, then use
`pnpm dev:sim -- --sim <name>`. The launcher discovers the session origin and
persists the app's development server choice. That database persists across
runs; see [local development](../../docs/local-development.md). The disposable headless and simulator lanes
have their own synthetic account and seed. SwiftUI previews use in-memory
fixtures, so editing the local database does not change a preview.

## Inspect and repair a warm simulator run

While `test:e2e:sim -- --watch` waits for Enter, use the session name, simulator UDID,
and agent-device state directory printed by the command in a second terminal.
For example:

```sh
pnpm exec agent-device snapshot -i --diff --platform ios --udid <udid> --session <session> --state-dir <state-dir>
pnpm exec agent-device screenshot --platform ios --udid <udid> --session <session> --state-dir <state-dir> --out /tmp/cubby-screen.png
pnpm exec agent-device logs path --platform ios --udid <udid> --session <session> --state-dir <state-dir>
```

The runner prints the synthetic product's `cubby://entity/<code>` deep link.
Open it in the same session to jump straight to its detail screen. To change
the replay, edit `apps/apple/e2e/product-edit-warm.ad`; a failed replay leaves
the server and database alive so you can inspect the screen, adjust the flow,
and press Enter again. `agent-device replay --save-script` can capture a repaired
flow, and `--from` can resume a divergent replay using the digest in its error.
Use the full `test:e2e:sim` flow to check navigation through Search.

A runner watchdog timeout while typing is not by itself evidence of a slow app:
sample both the app and the runner and check the runner's selected identifier
and `TEXT_ENTRY_PHASE` timings first. agent-device binds a coordinate-chosen
input by query index, which resolves to a different input once focusing scrolls
the form; the pinned patch re-queries the input by its accessibility identifier
instead (see [Tester Army](../../docs/tester-army.md)). A focused input touching
the keyboard's prediction bar is a separate layout issue; successful automation
does not verify keyboard clearance.

Ctrl-C closes the runner's agent-device session and drops its database. The
detached watchdog closes the session and drops that database if the runner is
killed. Simulator runs leave evidence under `artifacts/sim-dev/<database>/`,
including a screenshot and UI tree after replay failure; use
`test:e2e:sim -- --video` when a reviewable MP4 and contact sheet are needed.

## Timing on one local Mac

These are observations, not budgets: a full simulator run took 3m27s warm and
7m32s after a branch switch and FFI rebuild. A one-shot headless run took
75.5s warm, mostly setting up workerd and the database. Once headless watch
was warm, the native scenario took 331ms with unchanged Swift and about 6s
after a Swift edit. Those watch figures exclude the one-time setup and the
small per-rerun seed step. The local warm simulator replay measured 16–28s
from Enter through the database check after its initial setup. App build and
runner preparation still dominate the first run. Xcode MCP preview timing
varies by build state;
the repository's [Xcode MCP guide](../../docs/agents/xcode-mcp.md) records
roughly 15s for a warm render and 40–80s after a code edit.

`pnpm apple check` and the normal PR checks remain the broader validation
gates. The simulator flow is a targeted acceptance check for native UI
behavior, so it does not need to run on every edit.

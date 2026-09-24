# Fast native iteration

Pick the smallest loop that can show the behavior you changed. Keep the simulator
booted and the relevant build artifacts warm while working on one feature.

| Change or question                                                     | First loop                                                                                         | What it exercises                                                                                                           |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Pure `CubbyKit` logic, parsing, patching, or state                     | Run a focused Swift test with `swift test --package-path apps/apple/CubbyKit --filter <test-name>` | The real package code on macOS; no server or simulator.                                                                     |
| An ad hoc native API or local-file question                            | `pnpm apple cli <command>`                                                                         | A small `CubbyKit` executable, without building or launching the app. Use `pnpm apple cli --help` to see commands.          |
| Native API/auth/search/edit behavior                                   | `pnpm test:e2e:headless:watch`, then press Enter to rerun                                          | The `cubby` CLI against workerd and a disposable seeded database. It does not run `AppModel`, navigation, or SwiftUI.       |
| One SwiftUI screen or state                                            | Render that file's `#Preview` with Xcode MCP `RenderPreview`                                       | The view with synthetic, in-memory `PreviewFixtures`; no server or login. Inspect the returned PNG in Codex.                |
| App model or navigation logic                                          | Xcode MCP `RunSomeTests` for a focused app test                                                    | App-target code that the `CubbyKit` package tests and headless CLI do not compile or execute.                               |
| Taps, navigation, sheets, keyboard, or accessibility                   | Use Xcode MCP device interaction or `agent-device` on an already installed simulator app           | The running app and its UI tree. Use `pnpm apple sim` to rebuild and install after code changes.                            |
| A repeatable native user journey against a fresh database              | `pnpm test:e2e:sim`                                                                                | Debug iOS app, real auth, workerd, synthetic seed, agent-device assertions, and database readback.                          |
| A reviewable recording of that journey                                 | `pnpm test:e2e:sim:video`                                                                          | The same flow plus `run.mp4` under the run's `artifacts/sim-e2e/` directory. Open the file in Codex or attach it to a task. |
| Device-only behavior (camera, permissions, performance, installed app) | `pnpm apple ios` on a paired iPhone                                                                | Real device behavior; use Xcode/agent-device for interaction and diagnostics.                                               |
| Mac-specific UI                                                        | `pnpm apple mac` and Mac previews/tests                                                            | The native macOS shell and window behavior.                                                                                 |

## Recommended loop

1. Edit a `CubbyKit` algorithm or model and run its focused Swift test. For a
   networked native change, start `pnpm test:e2e:headless:watch` once, then press
   Enter after each edit. The first run builds workerd and the CLI; later runs
   reuse the server and database, seed a new synthetic product, and rebuild the
   CLI only when Swift sources changed. Restart after web or Rust FFI changes.
2. Edit a SwiftUI view and render its nearest `#Preview` through Xcode MCP.
   `PreviewFixtures` contain synthetic, wire-shaped states and intentionally
   block network reads. Add focused states such as empty, loading, error, dark,
   and large text when they expose the change. The generated fixture JSON comes
   from `pnpm --dir apps/web run gen:apple-preview-fixtures`.
3. When the change needs a real interaction, use Xcode MCP device interaction
   or `agent-device` against a warm simulator. Inspect the accessibility tree
   and screenshot; rebuild with `pnpm apple sim` after native code changes.
4. Run the scripted simulator flow for a cross-layer journey. Add `:video` when
   a human should review the exact UI actions. The database is unique per run
   and dropped afterward; artifacts stay under `artifacts/sim-e2e/`.

For manual exploration with a stable corpus, start `pnpm dev:local`, choose
**Local** in the app's Settings server picker, and use `pnpm apple sim`. That
database persists across runs. The disposable headless and simulator lanes
have their own synthetic account and seed. SwiftUI previews use in-memory
fixtures, so editing the local database does not change a preview.

## Timing on one local Mac

These are observations, not budgets: a full simulator run took 3m27s warm and
7m32s after a branch switch and FFI rebuild. A one-shot headless run took
75.5s warm, mostly setting up workerd and the database. Once headless watch
was warm, the native scenario took 331ms with unchanged Swift and about 6s
after a Swift edit. Those watch figures exclude the one-time setup and the
small per-rerun seed step. Xcode MCP preview timing varies by build state;
the repository's [Xcode MCP guide](../../docs/agents/xcode-mcp.md) records
roughly 15s for a warm render and 40–80s after a code edit.

`pnpm apple check` and the normal PR checks remain the broader validation
gates. The simulator flow is a targeted acceptance check for native UI
behavior, so it does not need to run on every edit.

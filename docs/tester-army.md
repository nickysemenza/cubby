# Tester Army trial

The manual web and iOS lanes exercise the same synthetic product rename and
reopen journey. Agent steps navigate and edit; exact UI and database assertions
decide correctness. Existing deterministic suites remain the merge gate.

## Failure modes and acceptance

Before implementing the runner, the relevant failure modes are: invalid or
missing inference credentials; unsupported image/tool calls; editing the wrong
product; a dismissed editor with an unsaved name; stale client state after
reopening; skipped or missing tests; lost run evidence; leaked credentials in
uploaded reports; and database, Worker, or simulator resources left after failure.

Acceptance requires three consecutive live runs per engine with fresh state and
zero retries, a failing wrong-name assertion, and one local replay comparison.
Model calls, tokens, reported cost, and timings are evidence, not a promise of
equal reliability or savings. The existing deterministic simulator product-edit
journey must also pass after the agent-device upgrade.

The CLI and mobile SDK share patched `agent-device` 0.21.20 through a workspace
override. Its iOS runner stops inspecting windows after finding a usable one
and avoids retaining full snapshot responses in its command journal. Hosted
startup and journey timings determine whether these changes improve this lane.

The pinned `agent-device` patch preserves the macOS infinite-bounds guard and
ignores an empty Toolbar whose bounds equal its entire enclosing panel during
occlusion checks, including flat iOS floating-bar nodes covering at least 95%
of the window width and 85% of its height. SwiftUI sheets expose that phantom Toolbar alongside their
form content; treating it as an opaque overlay blocks semantic field editing.
Toolbars with controls or smaller bounds still block covered targets. The iOS
rename journey exercises this regression through real semantic agent actions.

## Configuration and commands

Use a Cloudflare API token authorized for inference through Unified Billing.
Set it locally as `TESTER_ARMY_CF_API_TOKEN` or in the repository's Actions
secrets with that name. Local commands also accept `AI_GATEWAY_API_KEY` from the
shell or `apps/web/.env`; set `TESTER_ARMY_ENV_FILE` to use a different `.env`
path in a worktree. Only the inference token is read from that file, so app
database and storage settings do not enter the synthetic harness. The account
defaults to Cubby's configured Cloudflare account; `TESTER_ARMY_CF_ACCOUNT_ID`
overrides it locally or as an Actions repository variable. The gateway defaults to `cubby-testing`; override it with
`TESTER_ARMY_CF_GATEWAY_ID` locally. Do not reuse a deployment token.

The default is `openai/gpt-6-luna` through the Responses API, medium reasoning,
with gateway caching disabled. `TESTER_ARMY_MODEL` explicitly overrides the
model locally or through an Actions repository variable. There is no fallback.
The preflight verifies an image plus a forced function call before builds,
database provisioning, or simulator startup.

```sh
pnpm test:e2e:agent:preflight
pnpm test:e2e:agent:web
pnpm test:e2e:agent:ios
```

The web lane builds the Worker and owns a disposable authenticated database,
object storage, and Worker runtime. The iOS lane reuses the existing simulator
harness, synthetic fixture, local server, native build, and cleanup. Each run
uses fresh fixture state. Install the Chromium browser with
`pnpm --dir apps/web exec playwright install chromium` if needed.
The iOS prerequisites are the same as `pnpm test:e2e:sim`.

The shared Node setup restores the portable WASM package from the exact Rust
source key used by Linux jobs, avoiding a second macOS compilation.
The two optional macOS lanes disable pnpm store caching: measured installs took
47–76 seconds without it, while packing a store miss added 4m20s after tests
completed. A warm restore plus install took 91 seconds. Regular jobs retain
their existing pnpm cache; the WASM and Apple build caches remain enabled.
Both manual simulator lanes restore the same Xcode-versioned DerivedData cache
as the regular Apple build gate. Hosted builds use its SPM clone directory,
content-based source mtimes, native arm64 slice, and batch compilation. They
resolve package dependencies before validating a certificate for the cached app.
An unchanged toolchain, generated inputs, Swift and resource files, FFI bytes,
dependency pins, and complete app-bundle checksum allow compilation to be skipped.
Otherwise they run the normal incremental build and certify its result. The
required Apple gate always compiles and supplies the same certificate. The optional
GitHub native lanes start simulator boot during dependency setup, overlapping
startup with installation and cache restores. The harness still waits for boot
readiness before installing the app. Local runs start boot after compilation.
App replacement
uses `simctl` directly, before preparing the driver, so installation does not
start XCTest or inherit the SDK's short command timeout.
Both lanes also cache agent-device's compiled Apple test runner, keyed by its
package and Xcode toolchain. The SDK verifies source, SDK, and build settings
before reuse. Only its derived build directory is cached. Device leases,
per-session launch files, test results, logs, and lock files are excluded so
a new runner cannot inherit another host's process state.
Bundles record native build, boot, installation, and driver preparation durations separately.
If driver preparation fails, diagnostics retain the simulator screenshot and
original error without starting XCTest again for a UI snapshot. Failures after
successful preparation still capture the UI tree.
A cold cache still requires compilation; warm-cache performance must be
measured from the full hosted job, not just the agent test duration.

Dispatch **CI** manually with `tester_army` set to `web`, `ios`, or `both` and
`simulator_e2e` disabled. These optional jobs do not run on PRs and do not replace
the required checks. Run each engine three times for the live acceptance sample.

Append `-- --wrong-name` to either journey command to deliberately expect a
different name; it must fail the exact assertion. For a local replay comparison,
run the same command twice with `-- --replay`. This enables Tester Army's local
read-write cache; normal runs disable it. Compare the resulting summaries for
model calls, tokens, timings, replay hits and handoffs. Cache eligibility depends
on the engine's observed state, so a warm run may still use the model.

## Evidence

Bundles live under `artifacts/tester-army/web/<run>/` or
`artifacts/sim-tester-army-e2e/<run>/`. They contain `run-manifest.json`,
`run-results.json`, `agent-summary.json` when the engine produced one, and
`SHA256SUMS`. Verify transferred evidence from its run directory with
`shasum -a 256 -c SHA256SUMS`. Manifests record revision, source/build provenance,
replay command, status and phases. Dirty-source runs are not replayable evidence.

`apps/web/.e2e/runs/<lane>/<run>/` retains local SDK reports, screenshots,
traces and logs for diagnosis. The SDK requires its output inside the web
project; the harness copies only a validated summary to the run bundle.
CI uploads only the sanitized bundle files, with seven-day retention. The
summary includes only fixed synthetic case names and numeric usage/replay
metrics; credentials and fixture identifiers are excluded. Estimated cost may
be absent when the SDK does not report it. Telemetry is disabled.

Deterministic native replays print validated step counters, command names, and
elapsed milliseconds for timeout diagnosis. Selector values and session paths
are excluded from those progress messages.
Hosted native bundles also include `native-driver-diagnostics.json`: fixed SDK
startup phase names, cache outcomes, and numeric timings from this run. SDK
traces remain local to the runner; their arguments, responses, identifiers,
paths, and raw error text are excluded from the uploaded summary.

This trial establishes only the synthetic rename journey on Chromium and an
iOS simulator. It does not establish broader agent reliability or physical
device behavior.

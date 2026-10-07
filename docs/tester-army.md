# Tester Army trial

The manual web and iOS lanes run one shared catalog of synthetic journeys.
Agent steps navigate and edit; exact UI text and database read-backs decide
correctness. Existing deterministic suites remain the merge gate.

## Journeys

Each journey is described once in `apps/web/tooling/tester-army/journeys.ts`:
plain-language goals (an optional per-engine wording), exact on-screen text to
expect, and SQL read-backs with their expected rows. `tests/tester-army/web-journeys.e2e.ts`
and `ios-journeys.e2e.ts` are thin loops over that catalog, and
`tooling/scenarios/tester-army-journeys.ts` seeds one synthetic household that
gives every journey its own records, so destructive journeys never disturb each
other. Both engines read the same seed through `TESTER_ARMY_IDS_FILE`.

Select journeys with `-- --journey id,id` (omit it to run all) or one harness
with `-- --harness standard|coupled`. `-- --wrong`
(alias `--wrong-name`) corrupts every final database expectation, so a run must
fail at the read-back. Every passing read-back also asserts that the same query
does not satisfy a corrupted expectation, and `pnpm test:e2e:agent:selfcheck`
proves the comparison bites without any model call. Journeys are paced
(`TESTER_ARMY_PACE_MS`, default 20 s) because the inference gateway rate-limits
bursts of journeys.

Catalog: product rename; receive a purchase into stock; the add-to-inventory,
record-sale, set-status, mark-purchased and delete-with-impact-preview hero
actions; label nutrition, external ids, financial-account source aliases,
transaction source refs, source-claim description (identity preserved), recipe
line and product tag/collection editing; purchase validation; expense split
(cents conserved, unknown cost refused); attach expenses (move confirmation) and
products; task board lanes and moving a card; turning a mail-only vendor
account into a browser-synced one (its Vendor becomes an online account);
reading a finished mail import's Restart inputs (Vendor and order id); a
Run console journey (live progress, resolving a finding); and the Runs list
showing a live enrichment run's work label, target summary, latest step,
named targets and changed count, on desktop and at a phone width; and an
enrichment run's page counting Products (never orders) and naming its
targets. The Run console debug log is not cursor-paged in
the app (it caps at 2,000 events), so paging is not asserted. Three coupled
import journeys follow (see below).

A step can also `read` the screen: `agent.extract` returns structured data
validated by a Zod schema, and the harness compares it exactly (key order
aside) with what the seed implies. Use it for dense surfaces, where one
visible string cannot show that every fact is right. Under `--wrong` a read
must fail when it matches. A journey's `viewport` fixes the web viewport
before it opens its page, so the same catalog covers phone layouts. Prefer
exact text that appears once: a label that also names a hidden `<option>`
matches the hidden node first.

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

The patch also keeps text entry on the input that was tapped. The runner binds a
coordinate-chosen or tapped input by query index; when focusing it opens the
keyboard or scrolls the form, that index resolves to a neighboring input, and
XCTest then typed into an unfocused field until the runner watchdog fired (a
Product's external-ID Source resolved to URL; External id to ISBN). The runner
now re-queries such an input by its accessibility identifier when that is unique,
which stays bound to the same input. The runner's focused-input lookup cannot
recover it: it returns nil on iOS. The external-ID and recipe-line journeys
exercise it.

## Configuration and commands

The driver runs on the member's ChatGPT subscription by default
(`TESTER_ARMY_PROVIDER=chatgpt`). Sign in once per machine with
`pnpm --dir apps/web exec e2e login openai` (add `--device` for a device
code); the login is stored for the user in `~/.config/e2e/oauth.json` and
refreshes itself, so every checkout and worktree shares it. Hosted Actions
lanes default to `gateway` instead: the SDK reads `E2E_OAUTH_CREDENTIALS` as a
read-only store, so once a refresh rotates the token, the next job (or a
concurrent lane) presents the spent refresh token and fails `LOGIN_REQUIRED`.
CI can use the subscription only after refreshed credentials gain a writable,
serialized handoff between jobs. The default driver
model is `QUALITY_MODEL` (GPT-6 Sol); `TESTER_ARMY_MODEL` overrides it with an
id the plan serves (`pnpm --dir apps/web exec e2e models openai` lists them).
The preflight verifies an image plus a forced function call before builds,
database provisioning, or simulator startup, and a missing login fails it
with `LOGIN_REQUIRED`.

`TESTER_ARMY_PROVIDER=gateway` keeps the Cloudflare AI Gateway route: a
Cloudflare API token authorized for inference through Unified Billing, set as
`TESTER_ARMY_CF_API_TOKEN` (locally or as an Actions secret). Local commands
also accept `AI_GATEWAY_API_KEY` from the shell or `apps/web/.env`, falling
back to the primary checkout's file from a worktree
(`apps/web/tooling/local-secret.ts`); `TESTER_ARMY_ENV_FILE` names a different
`.env`. Only the inference token is read from that file, so app database and
storage settings do not enter the synthetic harness. The account defaults to
Cubby's configured Cloudflare account; `TESTER_ARMY_CF_ACCOUNT_ID` overrides
it. Gateway traffic uses gateway `cubby` with `environment=ci` in Actions and
`environment=development` locally, plus stable `feature` and `operation`
dimensions; revisions stay in the sanitized E2E run bundle. Gateway models
are OpenAI Responses ids (`openai/gpt-…`, default `openai/${FAST_MODEL}`).

The coupled import journeys always need that token as well, whichever
provider drives: their peers forward the application's own Workers AI (Jev
decisions, embeddings) and Anthropic recovery calls through the gateway. An
explicit agent swap accepts only OpenAI chat models because the peer speaks
the Responses protocol. Blank Actions
variables use these defaults rather than becoming invalid values.

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

Manual GitHub web and native lanes reuse the regular CI Worker artifact when
a successful push run published one for the exact tested commit. The existing
source and output fingerprint checks still run; missing, expired or invalid
artifacts fall back to a normal build. Pull-request merge artifacts are excluded
because they were built from a different commit.

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
GitHub native lanes start simulator boot after dependency installation, overlapping
startup with Apple tool setup and cache restores. Booting during extraction and
generation increased observed dependency setup from 42 seconds to 84–386 seconds;
these runs were not a controlled comparison. The harness still waits for boot
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
Failed deterministic replays also retain a fixed projection of the SDK's text
commit polling: elapsed time, requested/observed character counts, matched prefix
length and outcome. The reporter reads it before the isolated replay daemon is
removed; field contents and the raw runner log are excluded.
If driver preparation fails, diagnostics retain the simulator screenshot and
original error without starting XCTest again for a UI snapshot. Failures after
successful preparation still capture the UI tree.
A cold cache still requires compilation; warm-cache performance must be
measured from the full hosted job, not just the agent test duration.

Dispatch **CI** manually with `tester_army` set to `web`, `ios`, `both`, or `import` and
`simulator_e2e` disabled. CI's `web` lane runs `--harness standard`; `import`
runs `--harness coupled`, and CI also runs it weekly on `main` (Mondays 09:17
UTC); a scheduled run has empty inputs and skips every other job.
These optional jobs do not run on PRs and do not replace the required checks.
Run each engine three times for the live acceptance sample.

Append `-- --wrong` to either journey command to deliberately expect wrong
database values; it must fail the exact assertion. For a local replay comparison,
run the same command twice with `-- --replay`. This enables Tester Army's local
read-write cache; normal runs disable it. Compare the resulting summaries for
model calls, tokens, timings, replay hits and handoffs. Cache eligibility depends
on the engine's observed state, so a warm run may still use the model.

## Coupled import journeys

Journeys tagged `coupled` (web only) run on the purchase-agent workerd harness
instead of the standard E2E runtime: the built `cubby` Worker with its queues,
Durable Objects, MCP, background queue consumer, and object storage
(`createE2EObjectStorage`). A run selecting both kinds starts each harness in
turn and merges their summaries. Nothing behind the browser is scripted except
the synthetic sources: the harness's two model peers are
`tooling/tester-army/live-gateway.ts`, so the pi coordinator and the web
Worker's extraction, audit, and image description call real models through
the same `cubby` gateway and token. The forwarding peers preserve application
feature/operation metadata and bypass gateway caching. `tooling/scenarios/tester-army-coupled.ts`
seeds the sources:

- `import-order-mail`: a saved itemized confirmation (an HTML product link on
  the Vendor's site) and its shipping notice; the member imports the order from
  the vendor page. Without a click, both emails link to the Purchase as
  `cubby-system` decisions, the Purchase is dated by placement and belongs to
  the member's mail-only account, and the new Product keeps the email's
  product link.
- `import-order-mail-enrich`: the same on a browser-synced account; the
  commit also starts one `product_enrichment` run on that account at the
  product page.
- `import-photo-inventory`: two synthetic photos uploaded over the native HTTP
  API (create run, stage, PUT, finalize). The journey waits for their cloud
  descriptions, starts grouping, waits for the agent's proposals, and
  approves them; two Products must result.
- `import-account-sync`: a browser-synced vendor account with one finished
  sync and a simulated Mac browser (the queue producer's `/browser-connect`)
  answering its order-history page and one order by URL with a DOM snapshot,
  as the thin Mac app does; the server derives each page. The member starts the
  next sync from the finished run; the agent walks the history, captures the
  order, and imports it.

Cloud description fetches the photo back through its public object URL, and
the external-fetch guard refuses loopback hosts by name, so the harness serves
local storage at `storage.localtest.me` (public DNS for 127.0.0.1) through a
Host-rewriting proxy (`tooling/tester-army/public-storage.ts`); the photos are
JPEG because local storage serves `/cdn-cgi/image/` renditions as the original
bytes. The seed unpauses image processing, which a fresh database starts paused.

A step can wait for background rows (`ready`) or a live run state
(`awaitRun`: `awaiting_approval` or `completed`) before acting. A run that
settles anywhere else fails at once with its last progress and failed
operations. Final assertions read the imported Purchase, its expense total,
the imported order candidate, or the committed photo groups.

The coordinator runs on the model production sends unless
`TESTER_ARMY_AGENT_MODEL` (and optionally `TESTER_ARMY_AGENT_EFFORT`, default
`high`) is set locally or as an Actions repository variable; then the agent's
peer swaps that model into its `/openai/responses` calls
(`tooling/responses-model-swap.ts`, shared with the live coordinator eval).
The web peer's calls are forwarded unchanged. The run manifest records
`agentModel` and `agentEffort` (`production` when unswapped), and the bundle adds
`gateway-usage.json`: request counts, wire models, and failed statuses per
gateway route for each peer, never content. Those two files are the record of
the swap: the run page's generation telemetry and AI spend still name and
price the agent's pinned model. Deterministic coverage of the same
orchestration stays in `purchase-agent-scenarios.integration.test.ts`; these
journeys check that real models complete it.

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

This trial establishes only the synthetic journeys above on Chromium and an
iOS simulator. It does not establish broader agent reliability or physical
device behavior.

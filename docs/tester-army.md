# Tester Army trial

The background web and iOS lanes run one shared catalog of synthetic journeys.
Agent steps navigate and edit; exact UI text and database read-backs decide
correctness. Existing deterministic suites remain the merge gate.

Keep browsers and simulators local; paid hosted infrastructure is out of scope.
A full runner migration has no demonstrated CI speed advantage, so the
deterministic merge gate stays until matched-coverage measurements justify
changing it.

## Journeys

Each journey is described once in `apps/web/tooling/tester-army/journeys.ts`:
plain-language goals (optional per-engine wording or phases), exact on-screen text to
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
(`TESTER_ARMY_PACE_MS`, default 5 s) because the inference gateway rate-limits
bursts of journeys. Twenty journeys add 100 seconds of pacing, rather than the previous 400 seconds.

The catalog module owns journey names, supported engines, goals and assertions;
use the runner's selection flags instead of a second prose inventory. Run-log
paging is not asserted when the app supplies only a bounded event list.

Split compound edits into observable phases, and do not require dismissing a keyboard that may already be gone. Hybrid steps tap known native control IDs or exact accessible web controls (buttons or comboboxes) when model targeting or completion is ambiguous. Field entry stays agent-driven, and the UI and database assertions still establish the result. Native confirmations use the keyboard Done button, actual editor Save or `heroAction.submit` control for that surface.

Delete-preview journeys seed an incoming child task and assert its declared cascade before confirming. An outgoing project name can remain visible behind the web dialog and does not prove the impact preview rendered. The database checks establish that preview writes nothing, confirmation deletes both tasks, and the project survives.

The native unknown-cost split leaves both inputs untouched and checks the disabled submit control, visible refusal, and persisted null cost. Its accessibility snapshot exposes the `0.00` placeholder as a value; that text does not establish that a cost was entered.

A goal names both the requested action and its visible end state. Jev must
recognize when the action has finished; exact UI and SQL checks still decide
correctness. Product rename reopens the editor, extracts its Name, and closes
it before the final read-back.

A step can also `read` the screen: `agent.extract` returns structured data
validated by a Zod schema, and the harness compares it exactly (key order
aside) with what the seed implies. Use it for dense surfaces, where one
visible string cannot show that every fact is right. Under `--wrong` a read
must fail when it matches. A journey's `viewport` fixes the web viewport
before it opens its page, so the same catalog covers phone layouts. Prefer
exact text that appears once: a label that also names a hidden `<option>`
matches the hidden node first.

Web receiving opens Location and taps its uniquely named option through the SDK before agent amount entry. The option tap waits for the actual choice to load; substring matching excludes its generated code and ancestry. Web deletion confirms through the exact Delete button scoped to its impact-preview dialog; the preview and cascade SQL checks remain the outcome oracle. Both actions previously succeeded before model completion returned a false failure.

The web fixture waits for `[data-hydrating]` controls to clear after opening or
reloading a page. Jev cannot choose a server-rendered Edit button while the app
intentionally disables it until React attaches its handlers. This wait observes
the application readiness contract; it does not add a fixed delay. After database readiness and a reload, wait for the relevant live action to render before giving Jev its goal; cleared hydration markers do not establish data-dependent action readiness.

Tester Army and its decision/mobile SDKs run unpatched. Goals use the existing
searchable web picker inputs. The native external-ID journey splits source,
and identifier into separate goals that explicitly use the app's Done
button, then taps the known Save control as a supported hybrid step. External-ID and source-ref fixtures establish a reachable structured-entry row, centered in
the measured Form viewport; product rename covers editor navigation. The generic native editors
expose that shared Done action and render structured fields as separate Form
rows for keyboard avoidance. Token-entry fields derive stable identifiers from the entity and field keys so the native driver can rebind them after keyboard movement. Source-alias row creation uses its known Add control before field entry. Rename finishes field entry before an exact SDK Done tap. The Split sheet reuses the shared keyboard Done accessory; split entry dismisses it between every name and cost input before checking conservation. Source-alias, transaction source-ref and sale entry dismiss the keyboard between fields; the floating Done accessory can otherwise cover the next input. Keep unsupported interaction handling in the
journeys or product UI rather than patching the E2E SDK. Let English goals complete an action once; do not follow an approval goal with another SDK click on the same disappearing action. Persisted outcome checks verify completion. Goals end at observable
states, with exact database read-back establishing persistence. HTTP and network
inference failures fail once at Cubby's gateway boundary; aborts stay aborts.
Native keyboard Done uses the SDK’s exact button tap; editor Save and hero-action confirmations use `tapTestId` rather than model completion. Native identifier taps also require `role=button`, because iOS 26 can expose both a wrapper and its child with the same identifier: both compound
and simple Save goals returned inconclusive after successfully saving. The
following visible-value check and exact SQL assertions verify the saved external
ID, source and kind. Jev still enters the fields and drives product rename. Board navigation uses Jev; task-specific Move and lane choices use SDK taps before SQL read-back.

Native journeys wait for authenticated Library readiness before dispatching deep links, discard stale system confirmations, then wait for the exact target or the new Open in Cubby prompt before accepting once. Verify the seeded fixture code before setup. Lazy report actions must attach before scrolling for visibility; use their actual heading roles. Setup reveals the relevant editor region; Jev chooses the recipe amount input from its English goal. Known-input focus is only setup where keyboard avoidance requires it. Do not gate a journey on incidental focus state: persisted-value assertions establish whether entry worked. SDK Done waits until the keyboard control disappears before revealing the next input; source-claim setup clears the floating accessory through the measured label gutter so the gesture does not select text.

Reveal controls within their actual Form, detail or catalog container using slow scrolling and bounded measured centering; offscreen AX nodes can report a tap without changing state. Scroll back up for input corrections, and reveal footer warnings without requiring them to reach the viewport center. Browse catalog Tasks navigation is scoped to its list; global Find searches records. Split confirmation taps stay scoped to their group when the underlying detail action remains accessible. The native SDK transition budget is two seconds because AX bounds can arrive before scrolling pixels settle. Keep one activation and the existing visible-state and SQL outcome checks.

## Failure modes and acceptance

Freeze all source files until every concurrent SDK run has exited, including formatters, imports, and cases that already failed. Startup is not an edit boundary. The SDK can re-import a test module between cases while retaining its dependency exports; changing a fixture import during a run caused a worker crash before the next case. Collect repairs while tests run, then edit after all runs exit, rebuild the fingerprinted input, and run only the affected cases. Evidence from an edited running tree is exploratory, not exact-revision acceptance.

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

The CLI and mobile SDK share patched `agent-device` through a workspace
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

The driver always uses Tester Army's decision executor with `typesafe/jev`
through Cloudflare's gateway-scoped Workers AI `/ai/run` route. There is no
provider switch or text-model fallback for decisions. Jev chooses semantic UI
actions; a separate Gateway OpenAI model writes field values and handles
extraction and judgment (`TESTER_ARMY_MODEL`, default `openai/${FAST_MODEL}`).
Jev is text-only, so screenshot/coordinate decisions remain disabled.

Set `TESTER_ARMY_CF_API_TOKEN` locally or as an Actions secret. It must authorize
Workers AI inference and OpenAI inference through Unified Billing. Local
commands also accept `AI_GATEWAY_API_KEY` from the shell or `apps/web/.env`,
falling back to the primary checkout's file from a worktree.
`TESTER_ARMY_ENV_FILE` names a different `.env`. Only the inference token is
read from that file; application database/storage settings do not enter the
synthetic harness. `TESTER_ARMY_CF_ACCOUNT_ID` overrides Cubby's default account.
All traffic uses gateway `cubby`, cache bypass, `feature=tester-army`,
`operation=driver`, and `environment=ci` or `development`. Revisions stay in the
sanitized run bundle. No TypeSafe API key or ChatGPT OAuth login is needed.

Preflight checks a real Jev choice and the text tier's image/function-call
capability before builds or test services. Missing credentials fail early.
Bundles name both models; exact database read-backs decide correctness.

Compatible SDK versions and the shared `agent-device` patch are owned by
`apps/web/package.json`, `pnpm-workspace.yaml`, and the lockfile. Paid hosted
engines are not installed.

```sh
pnpm test:e2e:agent:preflight
pnpm test:e2e:agent:web -- --journey product-rename
pnpm test:e2e:agent:web -- --journey product-rename --debug
pnpm test:e2e:agent:ios -- --journey product-rename
```

`--debug` on the web lane retains the executor's decision transcript locally
for diagnosis. Raw model transcripts are excluded from the sanitized upload.

The coupled import journeys always need that token as well, and
their peers forward the application's own Workers AI (Jev
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

GitHub web and native lanes reuse the regular CI Worker artifact when
a successful push run published one for the exact tested commit. The existing
source and output fingerprint checks still run; missing, expired or invalid
artifacts fall back to a normal build. Pull-request merge artifacts are excluded
because they were built from a different commit.

The shared Node setup restores the portable WASM package from the exact Rust
source key used by Linux jobs, avoiding a second macOS compilation.
Dependency install/WASM/cache wiring is owned by the setup actions. Store
restore/save exceeded registry installation cost in the retained measurements.
Apple FFI uses the same target-specific action as required Apple CI. On a
GitHub output-cache miss, jobs with installed workspace dependencies use the
existing Nx artifact cache before compiling. Archive jobs without those
dependencies retain their direct build path.
On an Nx simulator-app cache miss, Tester Army iOS jobs restore both the SPM
package cache and the Xcode-versioned DerivedData cache used by the Apple gate.
Keep both together: DerivedData workspace metadata can refer to binary artifacts
such as Sentry's XCFramework that live in the SPM cache. The harness generates
the project and invokes the Nx simulator-build target before installation;
unchanged inputs reuse its app output, while changed inputs compile normally.
The required Apple gate uses the same cached target. Hosted native jobs start simulator boot after dependency installation;
booting during extraction/generation caused contention. Local runs boot after
compilation.
The harness still waits for boot
readiness before installing the app. Local runs start boot after compilation.
App replacement
uses `simctl` directly, before preparing the driver, so installation does not
start XCTest or inherit the SDK's short command timeout.
Native jobs also cache agent-device's compiled Apple test runner, keyed by its
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
Native journey jobs (Tester Army iOS and the simulator journey) first reuse
the existing Nx simulator-build cache probe through `setup-apple`'s `probe`
input. A cached app skips the large Swift package-clone and DerivedData
restores; a miss keeps the shared compilation setup. FFI verification, project
generation and the device runner remain necessary even with a cached app.

Journeys are informational jobs in `ci.yaml`; [CI](ci.md#journeys) owns their
triggers, run modes, concurrency and runner budget. They run only by a journey
dispatch or explicit PR labels; there is no scheduled matrix or changed-file
selection of paid journeys. The labels select independent lanes:

- `tester-army`: three web smoke journeys (`product-rename`, `receive-purchase`,
  and `field-product-tags`).
- `tester-army:ios`: the native catalog in two SDK shards.
- `tester-army:import`: coupled import journeys.
- `simulator-e2e`: the deterministic simulator search journey.

Only same-repository PRs run journeys, and labels remain active on subsequent
pushes. Adding a label starts its journeys at once, alongside rather than after
CI; the run rechecks the open PR, exact head, repository and current labels
before selecting lanes, so removed labels cannot start paid work. A journey
dispatch selects the requested catalog directly.

No journey lane is required for merge. The GitHub reporter takes the PR number
and head from the pull_request event and retains comments, summaries and
uploaded artifacts; a dispatch has no PR to comment on.

Workflow declarations own lane timeouts; they are limits rather than measured
run times. Hosted costs, timing and findings must justify expanding coverage.

PR runs enable verified action replay, with separate lane/OS/lockfile caches.
Each completed run saves a unique recording snapshot even after a journey
failure, preserving newly verified actions and invalidations. Replay verifies
the current end state and hands off to live inference when needed; it does not
reuse a previous test verdict. Recordings are scoped to the PR's branch, so a
PR's first run starts cold. Dispatches disable action replay and do not seed
it.

There is no schedule; required deterministic checks remain the merge gate.
Live acceptance uses fresh state across repeated engine runs.

Append `-- --wrong` to either journey command to deliberately expect wrong
database values; it must fail the exact assertion. For a local replay comparison,
run the same command twice with `-- --replay`. This enables Tester Army's local
read-write cache (`apps/web/.e2e/cache/`); local runs without this flag disable it. Label-requested PR journeys enable it. Compare the
resulting summaries for model calls, tokens, timings, replay hits and handoffs.
Each run seeds fresh records, so every step passes the journey's seeded
shortcodes as `unique()` params (`replayParams`): the SDK otherwise reads
`/PRD-4K7M` as a literal route and misses with `wrong-context`. A step records
only when a later on-screen check (a `check.visible` or the journey's
`visible` text) passes; database read-backs and screen reads do not confirm it,
so a step followed by neither runs live every time. A warm run may still hand
off when its recorded controls or end state no longer match.

## Web coverage additions

`record-picker-desktop` and `record-picker-phone` exercise purchase relationship
names and inline vendor/project selection against a roster longer than the
popup. Each opens the picker without typing or scrolling, checks that its current
option is visible, searches for a replacement project, and verifies the stored
project and unchanged vendor through SQL. Stored codes must be absent from the
visible record values. Run them with
`pnpm test:e2e:agent:web -- --journey record-picker-desktop,record-picker-phone`.

The existing web harness supports `TESTER_ARMY_WEB_MODE=visual` for three SDK
`toHaveScreenshot` assertions: the structured source-claim editor, cent-short
split refusal, and phone-width Inventory empty state. Normal model-driven and hybrid SDK
steps reach these states; exact values/disabled controls and PNG comparisons
establish the result. Baselines live beside `web-visuals.e2e.ts`, keyed by target
and OS. Missing or changed baselines fail and retain candidates/diffs. Capture
on the CI OS/device, mask only dynamic values, review images, and commit them.
Only explicit `--update-snapshots` in visual mode replaces baselines.

`TESTER_ARMY_WEB_MODE=explore` restores a `synthetic` setup session using cookie
injection, then uses the built-in text-model explorer rather than Jev. The charter focuses on editing, pickers and expense validation; all seeded
records are disposable and may be created, edited or deleted. It has four
exploration steps and a five-minute budget. Findings need a failing reproduction before being called
product defects. Exploration does not use action replay.

```sh
TESTER_ARMY_WEB_MODE=visual pnpm test:e2e:agent:web -- --harness standard
TESTER_ARMY_WEB_MODE=visual pnpm test:e2e:agent:web -- --update-snapshots
TESTER_ARMY_WEB_MODE=explore pnpm test:e2e:agent:web -- --harness standard
pnpm test:e2e:agent:web -- --journey field-source-claim,finance-split-expense
pnpm test:e2e:agent:web -- --journey field-source-claim,finance-split-expense --replay
pnpm test:e2e:agent:web -- --journey field-source-claim,finance-split-expense --replay --strict-cache
```

The `tester-army-visual` and `tester-army-explore` journey dispatches run these modes.
Its existing synthetic artifact allowlist also retains missing PNG candidates.
Use the normal SDK reports/summary for durations, calls, tokens and replay;
no separate benchmark runner, report schema or model-free policy is introduced.
Strict-cache can still invoke models for new/gapped steps and judgments.

For migration evaluation, run the existing named Playwright source-claim and
cent-conservation regressions and the two matching agent journeys on the same
frozen revision with fresh state, then repeat the agent command with replay.
Separate setup from scenario time using existing bundles and SDK reports.
Retain every named regression and deliberately wrong expectation check. A
small passing sample does not establish long-term flake rates. Existing required
checks remain the merge gate until measurements support promoting a small
subset. Native-condition and WebKit expansion remain deferred.

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
seeds the sources. Mail fixtures reuse `authorizeSyntheticBackfill` for the same actor, member and mailbox before importing; the agent OAuth grant alone does not authorize paid model calls. A dated order assertion requires that date printed in the source body; receipt metadata alone does not establish the order date:

- `import-order-mail`: a saved itemized confirmation (an HTML product link on
  the Vendor's site) and its shipping notice; the member imports from
  the saved confirmation Email and opens its Run. Only the selected confirmation links to the Purchase, attributed to its Run actor with the retained source checksum. The unselected shipping Email must not start a paid Run. The Purchase keeps the printed order date and belongs to the member's mail-only account; the new Product keeps the email's product link. This follows the explicit per-Email admission contract in ADR 0011.
- `import-photo-inventory`: two synthetic photos uploaded over the native HTTP
  API (create run, stage, PUT, finalize). The journey waits for their cloud
  descriptions, starts grouping, waits for the agent's proposals, and
  approves them; two Products must result. Run notes identify the illustrated
  T-shirt and ankle boot as separate wardrobe items, leaving brand and size
  unknown. Without that owner context, the live model correctly asked whether
  the stylized boot silhouette was footwear or a non-apparel object.

Cloud description fetches the photo back through its public object URL, and
the external-fetch guard refuses loopback hosts by name, so the harness serves
local storage at `storage.localtest.me` (public DNS for 127.0.0.1) through a
Host-rewriting proxy (`tooling/tester-army/public-storage.ts`); the photos are
JPEG because local storage serves `/cdn-cgi/image/` renditions as the original
bytes. The seed unpauses image processing, which a fresh database starts paused.

A step can wait for background rows (`ready`) or a live run state
(`awaitRun`: `awaiting_approval` or `completed`) before acting. A run that
settles anywhere else fails at once with its last progress and failed
operations. The order journey imports from its seeded Email and opens the resulting Run link. The photo journey checks that Start grouping dispatches its Run before waiting for proposals; an undispatched Run must not claim grouping is underway. Before dispatch, browser E2E checks the enabled Start grouping action.

Coupled journey failures print the browser harness's sanitized Worker logs before cleanup. Inspect those logs for the underlying authorization or pricing error when the coordinator reports `model_error`; the SDK screenshot and run status alone can omit that exception.

Before starting a coupled harness, the host fetches the fresh official `models.dev` catalog with all model types and a 30-second deadline. Both live peers serve that exact response to the application's pricing client for the run. Hosted Worker fetches timed out under the pricing client's five-second deadline, leaving paid admission unpriced. No bundled catalog, synthetic rates or authorization bypass is used; a failed host read stops startup.

Final assertions read the imported Purchase, its expense total,
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

Transport regressions retain one-request failure for HTTP 429 and
connection resets, including response-body failure after headers. Cancellation
stays cancellation. Live preflight and dirty exploratory results do not
substitute for exact-revision journey acceptance.

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
CI uploads the summary/provenance bundle and the allowlisted synthetic
evidence described below, with seven-day retention. The
summary includes only fixed synthetic case names and numeric usage/replay
metrics; credentials and fixture identifiers are excluded. Estimated cost may
be absent when the SDK does not report it. Telemetry is disabled.

Deterministic native replays print validated step counters, command names, and
elapsed milliseconds for timeout diagnosis. Selector values and session paths
are excluded from those progress messages.
Hosted native bundles also include `native-driver-diagnostics.json`: fixed SDK
startup phase names, cache outcomes, and numeric timings from this run. Full SDK debug transcripts remain local to the runner. The uploaded numeric
summary excludes arguments, responses, identifiers, paths and raw error text;
allowlisted semantic failure traces are separate evidence.

This trial establishes only the synthetic journeys above on Chromium and an
iOS simulator. It does not establish broader agent reliability or physical
device behavior.

### Background CI evidence and PR summaries

Synthetic CI enables `TESTER_ARMY_CI_EVIDENCE=1`: each completed journey saves a
`verified-outcome` screenshot; failed attempts retain screenshots, semantic
failure traces and failure video. Artifact upload globs select the SDK's
`results/*/attempt-*/screenshots/*.png`, `trace.md`, `screen-at-failure.txt`
`attempt-*/video/` files, and the canonical `report.json`/`junit.xml` directly from `apps/web/.e2e/runs/web/` or
`apps/web/.e2e/runs/sim-tester-army-e2e/`.
The SDK redacts the inference token and session cookies registered in
`e2e.config.ts` before writing report/evidence text. Sessions, downloads
and full debug transcripts are outside the upload globs. Native video depends
on SDK/device support. Retention is seven days; the sealed run bundle remains
the provenance record. Use only the disposable synthetic harness for this export.

Native failure videos omit touch overlays: the driver's indicator-export pass can consume 70 seconds per case on hosted runners and exceed cleanup deadlines. Raw failure video, screenshots and traces remain retained.

The built-in `@e2e-dev/github` reporter posts results, usage/replay metrics and
evidence links to the PR and job summary. It updates its comment on reruns;
The web/import matrix uses lane keys to distinguish its comments. The SDK owns comment formatting and
escaping. Setup failures before the SDK starts are visible in the workflow's
failed job; they do not produce a fresh comment. Read the linked source revision
when reviewing results: the SDK does not check the current PR head before
updating its comment, so a cancellation race can publish an older revision.
Manual runs write job summaries without PR
comments. The existing `agent-summary.json` remains the machine-readable metrics
artifact. See [the SDK reporter docs](https://e2e.tester.army/docs/github).

[Web coverage additions](#web-coverage-additions) owns visual baselines;
diagnostic screenshots alone do not assert a baseline match.

Retain a small set of semantic UI journeys over shared primitives and important
workflows, backed by persisted-state read-backs. Do not grow copy-only or
per-entity UI assertions. Before deleting an existing deterministic test,
preserve its named regression in a stronger retained check and record the
replacement; this trial does not delete existing regression coverage.

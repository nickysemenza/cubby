# Continuous integration

Every required check is an Nx target. A target's `inputs` decide its cache
key; a passing result for the same key in the shared Nx remote cache, for the same
execution environment, replays in seconds and satisfies the
merge gate ([ADR 0009](adr/0009-content-hash-merge-gate.md),
[validation policy](agents/validation.md)). Before any lane starts, the `Plan`
job compares the tree with the last green `main` run and starts only the lanes
whose tasks' inputs changed; documentation bundled into the Worker is a runtime input
([ADR 0014](adr/0014-path-routed-ci-lanes.md)). A `main` push whose tree
already passed CI, usually a squash merge onto an unmoved `main`, starts no
lane at all. Merging to `main`
independently deploys the web Worker, including after a
documentation-only change; deployment never waits for post-merge CI.

`ci.yaml` holds the required checks, one `optional` matrix job whose
entries `Plan` builds (the purchase-import browser after relevant import changes or explicit manual opt-in,
and live Email decisions only with the separate manual opt-in), and the
informational [journey jobs](#journeys). Validation exposes generation, tokens, TypeScript, lint, Knip, bindings,
tooling tests, routing drift and Worker tests as named
steps on one runner. Once setup succeeds, independent steps run despite earlier
check failures; their failures still fail the job. Cancellation stops further
work. The web matrix likewise keeps `fail-fast: false`. Formatting and the
link check run in the same job when the docs lane is selected. This collects distinct failures without paying a fresh install
for every static check. One status context, `CI passed`, owns the merge gate.

## Journeys

Tester Army and simulator journeys are `ci.yaml` jobs that `Plan` selects
only from explicit PR labels or a journey dispatch; unlabeled changes, `main`
pushes and the nightly run start none. `tester-army` selects the web smoke
journeys, `tester-army:ios` the two native shards, `tester-army:import` the
coupled import journeys, and `simulator-e2e` the deterministic simulator
journey. Journey jobs are never in `CI passed`'s needs, so they add no
required check and no wall time to the required path; they spend runner time
and model credits only on a head whose CI passed. See
[Tester Army](tester-army.md) for replay, evidence and timing limits.

`Plan` runs in one of two modes:

- **Normal CI** (opened, synchronize, reopened, push, schedule, and a dispatch
  with an empty `journey`): the lanes route as described below, and the PR's
  current journey labels (read from the API, not the event) run their
  journeys after `CI passed` succeeds, so the next push cancels them. `opened`
  leaves labels to the `labeled` events GitHub sends after it, so they start
  once.
- **Journey-only** (a `labeled` event for a journey label, or a dispatch with a
  `journey` input): `Plan` selects no lane, `CI passed` is skipped under a
  different job name (a skipped job counts as success, so it must not carry
  the gate's name), and no `ci-green-v2-*` artifact is recorded. A labeled
  run reads the PR's current labels and exits cleanly if the PR is closed,
  comes from a fork, or its head moved past the event's head; that push's
  own run starts the still-labeled journeys. It starts nothing unless the
  head's latest `CI passed` check succeeded, and skips a lane whose check
  already passed or failed on the head.

Concurrency keeps ordinary PR events in one group per PR. A journey label's
run joins that group without `cancel-in-progress`, so it waits for a running
CI run instead of cancelling it, and a later push or closure cancels it (a
second label replaces a waiting label run, which then reads both labels). Any
other label's run gets a group of its own and its `Plan` job is skipped, so
nothing starts. A journey dispatch uses a group suffixed with its journey, so
it never cancels a full manual run on the same ref.

Journeys test the PR head (or the dispatched ref), not the merge commit. A
dispatch keeps the Nx cache on and skips the live Email entry; for example
`gh workflow run ci.yaml --ref <branch> -f journey=tester-army-web`. Accepted
journeys are `simulator-search`, `simulator-inputs`, `tester-army-web`,
`tester-army-visual`, `tester-army-explore`, `tester-army-ios`,
`tester-army-both`, `tester-army-import` and `tester-army-all`; `Plan` fails
on any other value.

Every journey job needs `CI passed` and runs unless it failed (a journey-only
run skips it). `setup-apple`'s `probe` input
replays the cached `apple:simulator-build` pass before the SPM clone and
DerivedData restores, which run only on a miss; the journey command then
builds a missing app. Native journey jobs take macOS slots beyond the two
that `Apple host tests` and `Apple simulator build` use, but only on PRs
carrying `tester-army:ios` or `simulator-e2e`. Only the Tester Army jobs get
`pull-requests: write`, for the GitHub reporter's PR comments.

## Cache keys and the remote cache

Ordinary PR, main, nightly and manual runs reuse valid Nx results. A nightly
selects every lane; it does not disable caches. It detects hosted-environment
drift without rebuilding unchanged targets merely because a day elapsed.

Result passes certify source inputs **and** execution identity. Web/test gates
include Node, platform/architecture, hosted image (or local kernel), CI mode,
locale and timezone. Web targets add ignored env files, generated WASM and the
selectors in `apps/web/project.json`; shard selection is keyed per target and
browser worker count is part of the target command. The Worker bundles all
`docs/**/*.md`, so those bytes participate in runtime keys. Native App source
is excluded only from web-specific passes; root tooling keeps broad coverage.
Rust checks include their actual compiler and platform. Portable generation and
WASM artifacts retain their own narrower, content/toolchain-based inputs.

Apple passes key the actual Xcode, Swift, SDK, macOS, architecture and Rust
compiler, plus normalized FFI flags/profile and the files/generated bytes each
target reads. A tiny Mac job selects the current Xcode **major** and observes
its environment without dependency installation or generation. Linux then
probes native results with that identity and generated inputs. A verified hit
avoids the expensive Mac build job, but environment discovery itself uses a Mac
slot. The build executor derives its own environment again: a different runner
cannot publish or reuse a pass under the discovery machine's identity.
Native-relevant PRs and cached nightly runs observe drift; unrelated PRs do not
allocate a Mac just to detect an unrelated toolchain update. Minor/patch updates
float within the configured major. TestFlight's toolchain policy is independent.
Swift formatting has its own platform/toolchain-aware result key.

A developer pass satisfies hosted CI only when all execution-sensitive inputs
match. Local Mac test results no longer substitute for Linux results. Native
passes can still replay across Macs with the same relevant environment.

Manual `scope=routed` uses the verified main baseline; `scope=full` selects all
lanes, still cached. `fresh=true` selects every lane and sets
`NX_SKIP_REMOTE_CACHE=true`: each runner starts with an empty local cache and
reuses prerequisites it just built, avoiding repeated WASM compilation. Fresh
results do not read or write the remote cache. This is separate from
`purchase-import=true` and `live-email=true`; live evaluations never start merely
because a run is manual or fresh. Manual aggregation is named `Manual CI
diagnostics`, not the required PR check, and publishes no passing-tree evidence.

The remote cache is `apps/nx-cache`, a Worker backed by R2, using Nx's supported
HTTP cache client. CI and local setup connect only when both cache credentials
are present and its health request succeeds. Fork PRs receive no credentials;
a cache outage falls back to real checks rather than failing on a remote-cache
transport error. Cache failures never constitute passes. The bucket expires
entries after 30 days. Rotate `CACHE_TOKEN` in the Worker and update the Actions
`NX_CACHE_TOKEN` secret together. Treat write credentials as trusted check
publishers. Browser and native compiler caches are separate from Nx result passes.

Use the supported Nx CLI and existing Actions. Do not derive hashes or inspect
archive internals with private Nx APIs. `nx affected` and `pnpm check:plan` select
candidates; neither proves a cached passing result. The guarded Apple probe
uses normal Nx execution: a hit replays; a miss fails before native work. Mac
build jobs probe again after queueing, so a pass populated meanwhile avoids
FFI/package/build preparation. Linux test lanes still set up before replay.

## Deployment reuse

The web deployment job supplies the same Nx cache credentials as CI. Its
`wasm: restore` setup restores the complete content-keyed worker, browser and
cookbook packages, with a real build on a miss or unavailable cache. The cache
Worker's own deployment does not depend on itself. Web compilation stays fresh
for the merged commit: it embeds source identity and uploads source maps, so a
PR's `dist` cannot simply be deployed as main. Current-main checks remain both
before build and before publication.

Sentry owns browser and Worker source-map uploads. The SSR build explicitly
emits maps, while Wrangler's duplicate upload is disabled to avoid Cloudflare's
compressed source-map size limit. Client maps are deleted after Sentry's upload;
server maps remain available for generated output references and Wrangler path
validation, outside the public asset directory.

## Local verification

`pnpm verify:local` is an optional local diagnostic; commands and when to use
it live in the [validation policy](agents/validation.md) and
[quality guide](agents/validation-quality.md). Facts that shape it:

- `--parallel=1` is deliberate: every tier is already parallel inside (vitest
  workers, Playwright workers, cargo, xcodebuild), and running tiers side by
  side on one host reproduces the contention that sequential tiers avoid
  — measured 2026-09-16, the web unit tier took 196s instead of 24s under
  `run-many`'s default parallelism and tripped a 5s test timeout.
- Selected targets replay from the Nx cache when their content is unchanged.
  The browser and workerd targets build the Worker inside their own command
  (`build-cf.ts --ensure`) rather than through `dependsOn`, because the
  `build-cf` key includes the Git commit for provenance and would rebuild before
  every replay.
- The textual order of the `run-many -t` list is not an execution-order
  contract; Nx dependencies provide the ordering (WASM before its consumers,
  web build before E2E). `verify:local:full` sets `NX_SKIP_NX_CACHE=true` so
  every target executes.

Commit hooks, push behavior, and the merge gate are defined in the
[validation policy](agents/validation.md).

Toolchain versions come from `.nvmrc`, the root `packageManager`,
`rust-toolchain.toml`, and the Apple setup action. Rust/wasm-pack, Apple
`container` on macOS (external PostgreSQL/IntegreSQL on Linux), and Playwright
browsers must be available; [test tiers](agents/validation-tests.md) cover database setup.
PostgreSQL remains the authoritative integration tier; Playwright defaults to
one worker on hosted runners and two on local macOS in `playwright.config.ts`,
the `e2e` target passes `--workers=2` for each shard. Both tiers reject an empty selection or an
unexpected skipped test without freezing the suite to a hand-maintained count;
a Vitest `-t` run accepts tests the pattern left out but still fails when the
pattern matches nothing or a matched test is skipped.
Browser verification always follows the current web build: the `e2e` target
runs `build-cf.ts --ensure` first.
The web build itself ensures current WASM and generated contracts before
bundling. Native CLI, test, and app commands ensure generated contracts before
compilation; artifact freshness belongs to these consumers, not Git hooks.

These cache and dependency changes reduce duplicate work and stale generated
artifacts, but do not promise that two simultaneous full verifications are
resource-safe on the same machine. Keep heavy local runs coordinated when the
host is constrained.

`pnpm apple check` runs lint, then uses the same cache-only guard as CI to
probe host tests and simulator compilation before FFI preparation. A miss
fails before native setup and is never cached. `apple:host-tests` runs
CubbyKit's package tests and the OpenAPI warning gate; `apple:simulator-build`
compiles `Cubby-iOS` for a generic simulator and caches the built app. Neither
boots a simulator. The independent `apple:lint` target runs Swift formatting
and the state-initialization rule without Xcode. For the native targets,
missing Xcode is a failure, never a cached successful skip. Build scripts retain the same native arm64 profile, package
pins and artifact preparation for local and hosted checks.
The `rust` target runs fmt/clippy/test per
crate (`recipebridge/project.json`, `cubby-ffi/project.json`). Clippy and tests
use the root workspace's `ci` profile: no debuginfo, incremental compilation,
or dependency optimization. These tests run in under a second; the development
profile's optimized dependencies add compilation work without useful runtime savings.
Cargo still needs check metadata and linked test artifacts, and the default
and browser/native feature sets remain separate checks. Both targets share
`target/ci` and run sequentially to avoid Cargo's target-directory lock.
Their broad `gate` inputs include the root profile and workflow; `rustc -V`
still keys the floating compiler.

The Rust job uses an explicit, pinned `Swatinem/rust-cache` step with prefix
`rust-gate-v3`; its key also hashes root `Cargo.toml`, because rust-cache hashes
member manifests but omits the virtual workspace's profiles. The job installs
only the root workspace (`workspace-filter: cubby`), which provides Nx without
installing the web packages or running their generator. The Nx Rust targets
compile their required dependencies when they run. CI does not run a
separate Clippy/`cargo test --no-run` population pass before Nx: that repeated
the targets' compilation and could spend time compiling even when Nx already
had a passing result. Only successful jobs save new compiler-cache entries.
A job that replays every target may save a small compiler cache; that affects
later compilation speed, not the validity of Nx's cached pass.

`cubby-ffi` and the WASM packages share the `recipebridge` Rust core and Cargo
lockfile, but each target needs its own compiled artifacts. EPUB extraction is
the separate wasm-only `recipebridge/cookbook` crate, and `cubby-ffi` turns off
`recipebridge`'s Worker-only default features (`html`, `ai-usage`), so Apple
targets compile neither the cookbook crate nor `page.rs`. The `rust` target
also lints `recipebridge --no-default-features`, the browser build.
The unused local Rust model-pricing export is removed; Cubby usage pricing
reads `models.dev` in TypeScript. Cookbook's upstream pricing table remains
transitive until the [pricing consolidation](https://github.com/nickysemenza/cubby/issues/2297) is completed.

`apps/apple/project.yml`'s `Cubby-iOS` scheme also lists CubbyKit's own tests
as a local package test target (`package: CubbyKit/CubbyKitTests`), so
`xcodebuild test -scheme Cubby-iOS` on a simulator runs both `Cubby-iOS-Tests`
and CubbyKit's package tests together — useful locally, but hosted CI does not
use it (see below). `apps/apple/CubbyKit/Tests/CubbyKitTests/VisionHardware.swift`
defines a `.requiresVisionHardware` trait that skips Vision-dependent
contracts (`SubjectLift`, `FeaturePrintIndex`) when running on the Simulator,
for whichever caller — local or hosted — ends up running that scheme there.

Two hosted macOS build jobs, `Apple host tests` and `Apple simulator build`,
run only when the Linux probe did not verify that target's pass for the observed
Mac environment. Discovery, host builds and simulator builds each have a
repository concurrency group with a non-dropping queue; at most one of each is
active. Native build setup probes again before expensive preparation. A fresh
run skips discovery/probes and executes against each build runner's actual
current toolchain, retaining local prerequisite reuse.
The host job runs the automatically generated
`CubbyKit-Package` scheme with `xcodebuild test` on the ARM macOS host — no
simulator. The aggregate package scheme includes all CubbyKit tests and the CLI
product; the library-only `CubbyKit` scheme has no test action. The command uses
`-onlyUsePackageVersionsFromResolvedFile` to keep the committed package pins.
Its `xcode-host-v1` cache stores `apps/apple/CubbyKit/.build`, including the
Xcode compilation cache under `.build/xcode` and the SwiftPM
warning-generator products. Package checkouts use the shared
`apps/apple/SourcePackages` clone cache that the simulator job saves. Xcode's `Build` and `Logs` directories are
excluded: tests rebuild products from cached compiler results rather than
restoring timestamp-sensitive objects and test bundles. Keys include the Xcode
toolchain, package pins, CubbyKit sources, and warning-check script. It then
runs `apps/apple/scripts/check-openapi-warnings.sh`, which fails on any
swift-openapi-generator warning (a schema the `CubbyAPI` build plugin would
silently drop). It reads the diagnostics the plugin printed into the test
build's log, which every hosted host build contains because Xcode's `Build`
directory is never restored; a build that skipped the plugin, typically a warm
local one, generates again with the pinned generator. A successful warning check records its content key inside
the cached `.build` directory; unchanged document, config, generator pin,
toolchain, and check script reuse that pass without rebuilding or regenerating.
Changed inputs run the full check, and warnings or generator failures never
record a pass. The simulator job restores its simulator-only FFI framework and
runs the generic-simulator build with no tests or simulator boot. Both jobs
use `!cancelled()` so whole-workflow cancellation can stop them while a failed
probe still falls through to macOS.

Each SDK keeps its own compilation cache. Parallel jobs use two macOS
runner slots to avoid adding the host and simulator compile times after a
cache miss or source change. A generated-schema change still recompiles the
client for each SDK; neither cache reuse nor a five-minute ceiling is guaranteed.
The generated `CubbyAPI` target forwards `-gline-tables-only` directly to the
Swift frontend, so the driver's default `-g` does not restore full debug type
information. Handwritten Swift targets retain their normal debug information.

Both native `xcodebuild` commands enable Apple's compilation cache and its
hit/miss remarks on the command line, so the SwiftPM package targets
(`CubbyAPI`, `CubbyKit`) use it too; the Xcode project's own setting reaches
only the app targets. Content-addressed results live in
`DerivedData/CompilationCache.noindex` for the simulator and
`CubbyKit/.build/xcode/CompilationCache.noindex` for the host, inside their
successful-build caches. This can replay compiler work when
ordinary build products need rebuilding but the compiler inputs are unchanged;
new source inputs still compile. Local `swift test` remains available and does
not use this Xcode cache.

Manual native E2E installation (`apps/web/tooling/sim-e2e.ts`) also runs
`apple:simulator-build`, restoring unchanged apps from Nx. Check those callers
when removing a shared build helper.

The earlier simulator-test job ran `xcodebuild test` on a concrete simulator:
first boot cost about 6 minutes plus roughly 10 minutes of CPU starvation
(a 5s script took 2.6 minutes, and compilation doubled). Host tests and the
generic-simulator app build keep that simulator work excluded.
`.github/actions/setup-apple` is the native setup every macOS job uses: Xcode
selection, the optional workspace install, an optional Nx cache probe, the
FFI slices, the Apple tools, and the optional simulator DerivedData restore.
`.github/actions/start-native-postgres` starts the macOS
E2E jobs' PostgreSQL, which cannot run service containers.
`setup-apple` installs XcodeGen and restores
`apps/apple/SourcePackages`, the `xcodebuild`-resolved SPM clones for Sentry,
GRDB, Nuke and swift-openapi-generator (previously an uncached "Resolve Package
Graph" on every run), used by both native jobs; `Apple host tests` skips
XcodeGen. A probe hit skips the clone and DerivedData restores. The clone
cache is separate from the target-specific FFI output cache and the
host job's build cache described above. DerivedData keys explicitly exclude
the host `.build` directory; its compiled products are not simulator source
inputs. Host and simulator caches have separate Xcode toolchain and package
graph keys. Dependency declarations live in XcodeGen’s included
`apps/apple/packages.yml`; app versions and build settings stay in the product
key, so a version bump does not discard dependency precompiled modules. A
package declaration, local Swift package graph, or resolved-pin change still
invalidates those modules. App pins live in `apps/apple/Package.resolved`;
Kit pins remain in `apps/apple/CubbyKit/Package.resolved`. Simulator dependency
cache keys include both lockfiles and both specs.

Compiled Apple caches are published only after successful work, through
`save-cache-main-only`: any run on `main` saves a new exact key over a partial
restore, and a PR saves only on a full miss. Main pushes of a tested tree run
no native build job; a native miss or deliberate compilation publishes `main`'s entries. GitHub cache
entries are immutable: an interrupted compile saved under the final key makes
later exact hits repeat unfinished work. Cache-generation names and keys belong
in the setup actions. Retire obsolete generations and merged PRs' private entries
with GitHub's cache controls after main is seeded; retain active PR/current main
entries. Dependency clones remain advisory; warm restores establish reuse,
not a required-check runtime guarantee.

## Hosted suite

The `CI` workflow runs automatically for pull requests to `main` and pushes to
`main`. Superseded PR runs are canceled. Closing or merging a PR also cancels
its remaining CI: the closure run shares the PR's concurrency group but skips
all jobs, including `CI passed`. The group retains the PR number when a merge
changes the event ref to `main`, keeping main's push run independent.
Main runs finish rather than being
canceled by later merges, so native checks can publish reusable caches.
GitHub concurrency keeps
one main run active and at most one pending; a newer push replaces the pending
run. This does not add parallel main runs or jobs. The newest main CI result may
wait for the active run; deployment remains independent.

`Plan` runs on the `ubuntu-slim` container runner. It records the tree it tests. Outward-text validation runs in the final gate so
a metadata error cannot suppress otherwise-runnable checks. On a `main` push it first asks
the artifacts API for a same-repository `ci-green-v2-<tree>` artifact, which
`CI passed` uploads only after a green run; if one exists, every lane is
skipped. A PR run tests its merge commit, so a squash merge onto the `main` it
was tested against pushes exactly that tree; if `main` moved, the trees differ
and routing proceeds as usual, catching interactions between merged PRs. An
API failure or missing artifact also falls through to routing. Otherwise it
finds the newest successful `main` push run of
`ci.yaml` carrying unexpired policy-v2 passing-tree evidence, and runs `dorny/paths-filter` with git (`token: ""`) on the
two-dot diff from that commit to the tested tree, matching
`.github/ci-lanes.yml`. `scripts/ci-lanes.ts` generates that file from the Nx
inputs of the tasks each lane runs (`LANES`), resolving named inputs,
`dependentTasksOutputFiles` producers, each task's own configuration, and the
runtime inputs classified by exact command; an unclassified runtime input
fails generation, and `cubby-checks:ci-lanes` fails when the file is stale.
`scripts/ci-lanes.test.ts` asserts that every file Nx's hash plan reads for a
lane's tasks selects that lane, and that every Nx task a lane's `ci.yaml`
commands run is one that lane routes. Any deleted or renamed file also
selects the docs lane, because it may be a relative link's target. `Plan`
runs the outward-text check on the slim image's own Node 24, without
`setup-node`; a missing or older Node fails `Plan` closed. Any tree compared with a green tree is
correct, ancestor or not: a lane whose inputs match would replay that tree's
pass. Nightly and full manual runs, and a repository with no green main run, start
every lane. Lanes with identical groups share one filter entry, named
`<lane>+<lane>.<n>`. `Plan` outputs the selected lanes, the matrix of web
lanes, the exact jobs it skipped, and the selected [journeys](#journeys).

`CI passed` is the single required check (`re-actors/alls-green` on
`ubuntu-slim`). It needs every lane and fails on any failure or cancellation,
and on any skip other than the jobs `Plan` skipped or an Apple job whose probe
verified a cached pass. A full manual CI dispatch also runs the informational live Email
decision entry of the `optional` job outside `CI passed`, calling Jev and Clef on synthetic cases through
the real gateway with `AI_GATEWAY_API_KEY` (passed only to that entry's step). Failures do not block the deterministic
merge gate. Real member inputs are refused in CI. A failed probe is allowed: it only sends both Apple
lanes to macOS. On success it uploads the `ci-green-v2-<tree>` artifact
(retained 14 days) that lets a `main` push of the same tree skip every lane.

`Validation and docs` runs when either lane is selected; `Plan` allows it to
skip only when neither is. With the validation lane it installs the workspace
and runs the cached generate, design-token, types, lint, Knip, CI-lane,
bindings, script-test and Worker-test targets as individual steps.
`pnpm check:all` runs those targets plus formatting locally.
Dependency advisory audits and deduplication are not CI or local validation
gates; dependency maintenance is handled separately from code validation.
With the docs lane it runs the `format` target and the offline relative-link
check; a docs-only change installs only the root tools. The link check runs through the pinned Lychee
action, a composite action that downloads the Lychee binary (no Docker).
Paths written as inline code are informational; link a repository file when
its existence should be checked.

`setup-node-with-deps` installs from the registry without a pnpm store cache:
measured restore/save cost exceeded fresh install cost. With `wasm: restore`
it replays Nx's WASM artifact from R2, outside the Actions cache, and builds
with the runner's Rust only on a miss. Compiler and SwiftPM caches are separate.

Generated output is never committed, except `.github/ci-lanes.yml`, which
`Plan` reads before any install; web and Apple jobs generate it during
`postinstall`. The Rust job's root-only install skips web generation, and
`Validation`'s `generate` gate checks that it generates cleanly and that the OpenAPI
document lints.

The `lanes` job is one dynamic matrix over the selected web lanes, one
standard runner per entry; only database entries start the PostgreSQL and
IntegreSQL service containers (an empty service `image` starts none).
`Auxiliary tests and builds` runs `nx run-many -t test`: every auxiliary
package's tests and the `unit`, `mcp-contract`, `worker-safety`, and `ui`
Vitest projects of the web app, each a cached target. Node projects run first,
then UI uses Vitest's standard project group ordering, keeping each phase's
worker environment together. `Build Workers and runtime tests` runs the
`db-check` migration drift check against disposable scratch databases and the
`integration-workerd` Vitest project against a Worker it builds itself. When
both lanes are selected they share one runner as `Auxiliary, Worker, and
runtime tests`, two steps that each run despite the other's failure; together
they take about as long as the slowest E2E shard and save a runner slot.
Desktop Chromium runs as two Playwright shards (two workers each) through the
`e2e` target, each building the Worker with the run's source commit and branch
provenance. Phone-web and WebKit browser coverage was removed from PR CI and the
Playwright suite; native checks remain separate. There is no coverage mode.
The disposable PostgreSQL container uses `fsync=off`, `synchronous_commit=off`,
and `full_page_writes=off`, matching the local test-service settings. These
[standard non-durable settings](https://www.postgresql.org/docs/17/non-durability.html)
remove disk durability work from synthetic test data; CI does not test database-server
crash recovery. SQL constraints, transactions, and the full reset still run.

CI records a Playwright trace only for the retry of a failed test
(`on-first-retry`), so passing tests pay no tracing cost; local runs keep
failure traces. Each browser job uploads Playwright's HTML report and those
traces for seven days, named by commit SHA and shard. CI runs use only
synthetic data and test credentials, so the report is safe to publish. Local
runs, including the manually dispatched native simulator E2E, keep their
reports, traces, and run bundles local because they may contain household data
or credentials.
`E2E tests (purchase import agent, optional)` runs the Playwright project of
that name (`purchase-import-run.spec.ts`: the purchase agent with a scripted
model and gateway, driven through the browser) through the
`e2e-purchase-import` target, building its own Worker. It is informative only:
it is outside `CI passed` and `continue-on-error`, so its failure leaves the run
successful. It uses the same `webGate` key as the
other web lanes and uploads the same Playwright report.
The `integration` Vitest project runs once through the `postgres` target
with four fork workers; local explicit partitions remain supported and separately keyed. The
`integration-workerd` project (the files that start the built Worker, listed in
`workerdIntegrationTests` in `apps/web/vitest.config.ts`) runs in `Build
Workers and runtime tests`. A workerd consumer missing from that list runs in
an ordinary integration shard and fails there, because in CI the harness
refuses to rebuild a missing or stale Worker. Jobs that need the databases
declare native GitHub Actions service containers; a YAML anchor reuses the
pgvector PostgreSQL and pinned IntegreSQL definitions. GitHub owns the network, container
startup, PostgreSQL health wait, logs, and cleanup. PostgreSQL also maps port
55432 for guarded named-database tests, on loopback only: 55432 is inside
Linux's ephemeral port range, and an all-interfaces bind failed container
startup when an outgoing connection held it. `POSTGRES_INITDB_ARGS` sets the disposable
settings in the fresh PostgreSQL 17 configuration. IntegreSQL retries its
PostgreSQL connection during startup; its pinned distroless image has no
`/bin/sh` for Docker shell health checks. The optional purchase-import and
Tester Army Linux lanes use the same service definitions. The
`@claude` mention workflow (`claude.yml`) remains on demand; a new mention on
the same issue or PR supersedes its previous response, while unrelated comments
do not cancel it. There is no automatic PR review workflow. Preview deploys
were removed; production is the only deployed environment.

## Apple TestFlight release

Normal merges to `main` wait for the nightly check at 10:17 UTC. It publishes
current `main` when files that can reach the app changed since the last complete
upload (the workflow's inline `full`/`apple` path filters),
or that upload is at least 30 days old. A changed
`APPLE_CLIENT_COMPATIBILITY_VERSION` in `packages/shared/src/apple-client-version.ts`
publishes promptly; comment-only edits do not. The shared value supplies both
the generated `MARKETING_VERSION` and server minimum. Bump it for wire-breaking
changes; compatible changes need only a new CI build number.

For an immediate build or retry, dispatch a fresh run:

```sh
gh workflow run apple-testflight.yaml --ref main
```

Publishing uses one pinned current-main commit, increasing build numbers, and
one active workflow. Reruns are refused, including checkpoint-only retries.
Each platform archives, verifies, and uploads on its own macOS runner. Only
both uploads succeeding records the upload as an immutable annotated tag,
`testflight/<version>-<build>`, on the uploaded commit, its message the
checkpoint JSON (`sha`, `version`, `build`, `uploadedAt`); only that job has
`contents: write`. The highest build among those tags is the last complete
upload, and `git tag --list 'testflight/*'` is the upload history. No-op and
partial releases do not advance it. No tag rebuilds; a malformed or
lightweight tag fails the plan. A partial failure's next fresh run rebuilds
both platforms. Each platform's archive enables Xcode's compilation cache for
every target and restores `xcode-release-v1-<platform>`, the newest main
release's content-addressed results (~1 GB each), so unchanged Swift, the
generated client included, replays instead of compiling; a successful main
release saves a new entry.

Uploads are internal-only with automatic group distribution. Verify processing
and installation in TestFlight after publishing: upload acceptance alone does
not establish availability. Server deployment remains immediate, so breaking
changes can leave an update-required period until the new app is installed.

After a long pause, manually re-enable scheduling and dispatch a fresh build.
GitHub can disable public-repository schedules after 60 inactive days; the
30-day refresh does not prevent this.

## Deployment

`.github/workflows/deploy.yaml` deploys the web Worker on every `main` push,
without waiting for post-merge CI. Required PR checks gate merging. It uses
`.github/actions/deploy-worker` to build once, apply committed production migrations
with the existing runner, then deploy `dist/server/wrangler.json` directly. It checks
current main before building and again after migration, before deployment.
Keep build, migration and deployment as named steps in the existing action;
avoid standalone wrappers and multi-operation command inputs.
Migration failure blocks deployment. The migration and deploy share the existing
non-cancelling production concurrency group. The required database credential is
scoped to the migration step; the Cloudflare credential is scoped to deployment.

Retry a failed release by manually dispatching `Deploy` on `main`; the runner
verifies and skips the already-applied migration prefix. If schema application
succeeds and deployment fails, the schema stays applied: roll forward with a
compatible deployment rather than resetting migration bookkeeping. Every push
must therefore be compatible with the code running before deployment. Staged
boundaries and breaking cutovers follow the
[production migration runbook](runbooks/production-migrations.md).
Migrations expected to exceed the deployment job's install/build/release time
budget belong on the operator-managed cutover path.

`.github/workflows/deploy-nx-cache.yaml` deploys the Nx cache only when its
source/configuration, dependency inputs, Node version, setup action, or its own
workflow changes. Manual dispatch can retry a deployment. It checks out current
`main` when the serialized job starts, so rerunning an old workflow cannot
roll the service back and a later docs-only push cannot suppress a pending
cache change. It uses a filtered install and plain `wrangler deploy` on
`ubuntu-slim`, with no separate build step. Both workflows keep credentials in
the deployment step's environment and serialize their own service deployments.

## Branch protection and measurement

The `main` ruleset requires only `CI passed`, from GitHub Actions. Keep `strict` disabled so
a green non-conflicting branch need not rebase, allow administrator bypasses,
and do not require human review.

Optimize readiness across four concurrent PRs on the existing hosted plan.
The Linux matrix admits two entries per PR; validation and short control jobs
are additional demand, and native/optional work has repository-level limits.
The normal web matrix has two browser entries, one PostgreSQL entry, and a
combined auxiliary/Worker entry. This reduces repeated setup and leaves room
for other PRs, main and release work; it does not reserve account-wide capacity
or guarantee fairness against unrelated repositories.

Use existing job reports and the `CI capacity` step summary to distinguish
created-to-start waiting, setup, job duration and Nx cache replay. Compare
readiness p50/p95 and total job-minutes when a tradeoff is unclear, but do not
hold a clear improvement for a fixed sample quota. Warm, cold and environment
changes are different populations. Native historical nightly/dispatch runs are
valid setup/build evidence; PR samples whose Mac jobs all skipped say nothing
about cold native queueing. The 4–7 minute warm goal is a target, not a measured
guarantee. Optional purchase import starts only after required CI succeeds and
uses one repository background slot. Superseded PR revisions cancel; sibling
failures do not cancel independent checks. Rust formatting, Clippy and tests
collect results separately, and Playwright has no failure-count cutoff; setup
failures and existing timeouts still bound impossible or stuck runs.

### Retained experiment conclusions

Collect naturally occurring successful PR runs before claiming a new median.
Compare queue time, required-check p50/p95, cache misses, cancellations,
job-minutes, and merge-to-deploy time. Historical experiment tables and run
links remain in Git history.

- More browser workers increased navigation latency and cumulative case time
  without a reliable critical-path gain. Shard counts and worker settings live
  in the workflows and Playwright configuration.
- Fast projects share a job to reduce runner demand outside the browser
  critical path. Each browser shard and the workerd job build their own Worker:
  a separate build job would add startup and install prerequisites.
- HTTP/2 proxying and WASM preloading did not improve end-to-end hydration.
  `context.route` asset caching disabled Chromium's HTTP/code cache and made
  navigation slower. Catch-all chunk grouping caused module initialization
  cycles; strict execution order stalled hydration. Fewer chunks needs a
  renderer-boundary refactor, not a bundler toggle.
- Playwright's fully-parallel sharding takes contiguous equal-count slices;
  one slow case stays on one shard. Keep cases short using page clocks or
  responses rather than poll intervals, instead of reordering specs.
- Local full verification runs tiers sequentially because each tier already
  parallelizes internally. Concurrent full runs caused contention and timeouts.
- Cache dependency artifacts when build savings exceed transfer costs. Store
  and `node_modules` caching lost to registry installation.

## Operational checks

Choose workflow/routing checks under the
[validation policy](agents/validation.md#before-opening-a-pr); workflow edits
use `actionlint`, and `pnpm check:plan` explains selected lanes without asking
for a broad local suite.

After a material workflow change, compare at least ten representative runs for
PR p50/p95 wall time, merge-to-deploy time, total job-minutes, cancellations,
and cache behavior.

# Continuous integration

Every required check is an Nx target. Cacheable targets' `inputs` decide their
cache keys; a passing result for the same key in the shared Nx remote cache replays
in seconds and satisfies the merge gate
([ADR 0009](adr/0009-content-hash-merge-gate.md),
[validation policy](agents/validation.md)). Every Linux lane starts on every
run and lets that cache skip unchanged work; only the Rust lane and the Apple
lanes are path-filtered ([ADR 0020](adr/0020-cache-routed-ci.md)). Selected
Apple host and simulator checks always execute on macOS, using ordinary compiler
and artifact caches. Merging to `main` independently
deploys the web Worker, including after a documentation-only change;
deployment never waits for post-merge CI.

`ci.yaml` holds the required checks and two informational jobs: the
purchase-import browser after relevant import changes or explicit manual
opt-in, and live Email decisions only with the separate manual opt-in.
Validation exposes generation, tokens, TypeScript, lint, Knip, bindings,
tooling tests, Worker tests, Swift lint, formatting and the link check as named
steps on one runner. Once setup succeeds, independent steps run despite earlier
check failures; their failures still fail the job. Cancellation stops further
work. The web matrix likewise keeps `fail-fast: false`. This collects distinct
failures without paying a fresh install for every static check. One status
context, `CI passed`, owns the merge gate. [Journeys](#journeys) live in their
own workflow.

The required test matrix splits its existing shards evenly between GitHub and
Celesto: half the browser shards use GitHub Ubuntu and half use Celesto XL;
half the Vitest shards use GitHub Ubuntu and half use Celesto XL. The workflow
owns exact assignments and counts. Per-runner worker counts stay unchanged.
Each shard restores or builds its own web output through Nx before testing;
there is no shared-build producer or artifact dependency. The existing build
ensure verifies provenance and supports standalone tests. Cold shards may build
in parallel; a compatible completed build can replay from the remote cache.

Plan, reporting and the final gate use GitHub's `ubuntu-slim`. Validation,
optional jobs and Apple jobs also stay on GitHub; Rust retains its ARM runner.
Deployment and other workflows retain their existing runners. This limits a
normal PR to four heavy Celesto jobs, spreading demand across both providers
without making native lane selection wait for Celesto admission. Celesto
browser shards trial XL at the existing worker count to isolate whether
additional CPU/memory reduces execution time; this is an experiment, not a
measured speedup.

Celesto hosts its machines; `self-hosted` is GitHub's label for runners outside
its hosted fleet. Enable the repository in the Celesto GitHub App and link it
to a workspace with paid credit for Large/XL and enough concurrent sandbox
capacity. The Micro-only trial cannot run these jobs. A queued runner is not
bounded by its execution timeout; insufficient credit or capacity can still
block the merge gate. Moving some jobs off GitHub frees its runner slots, but
does not guarantee Celesto capacity.

Self-hosted WASM consumers explicitly install Rust. Celesto browser jobs install
Chromium system dependencies even when its browser archive is cached. Setup
also restores `/dev/fd` when absent on Linux: Bash process substitution in the
WASM installer requires that link to `/proc/self/fd` on minimal images.
Celesto runs as root, so filesystem permission regressions inject the failing
syscall rather than rely on chmod restrictions that root bypasses. Celesto test
lanes set their own image identity for Nx result keys; GitHub lanes retain their
hosted image identity. Increment the Celesto identity when changing its runner
image contract. Reporting still merges blobs without building the app or
installing browsers and remains outside `CI passed`.

Standard GitHub-hosted runners are free for this public repository. Evaluate
push-to-result time, queueing, setup, uncached execution, report publication and
billed runtime before claiming a benefit. Larger runners do not automatically
increase configured test worker counts. Revert runner labels to GitHub's hosted
labels to end the experiment.

## Journeys

Simulator journeys live in `journeys.yaml`, outside the merge gate. The
`simulator-e2e` label on a same-repository PR starts the deterministic simulator
journey on the PR head and subsequent pushes. Manual dispatch selects
`simulator-search` or `simulator-inputs` on the dispatched ref. Unlabeled
changes, `main` pushes and nightly runs start neither. Relabeling or
redispatching cancels the older run.

Native journeys restore SPM and DerivedData caches before their build and take
macOS slots beyond the required Apple host tests and simulator build.
The optional Tester Army harness is retired, including its agent-driven
navigation, coupled live import/photo smoke, visual snapshots and action
replays. Their removal deliberately gives up that optional confidence;
retained deterministic checks do not establish equivalent coverage for every
retired catalog case. Required merge checks remain in `ci.yaml`.

## Cache keys and the remote cache

Ordinary PR, main, nightly and manual runs reuse valid Nx results. A nightly
starts every filtered lane; it does not disable caches. It catches what path
filters and declared toolchains miss without rebuilding unchanged targets
merely because a day elapsed.

Result passes certify source inputs **and** execution identity. Web/test gates
include Node, platform/architecture, the hosted image version, CI mode, locale
and timezone, each as a plain Nx `env` or `runtime` input. A runtime input's
command must print only deterministic stdout: Nx hashes stdout and stderr. Web targets add ignored env files, generated WASM and the
selectors in `apps/web/project.json`; shard selection is keyed per target and
browser worker count is part of the target command. The Worker bundles all
`docs/**/*.md`, so those bytes participate in runtime keys. Native App source
is excluded only from web-specific passes; root tooling keeps broad coverage.
Rust checks include their actual compiler, platform and Cargo warning policy.
CI establishes `CARGO_BUILD_WARNINGS=deny` for native compilation. Portable generation and
WASM artifacts retain their own narrower, content/toolchain-based inputs.

Apple host tests and simulator builds do not cache result passes. The selected
macOS jobs prepare FFI and use Xcode, SwiftPM and Cargo artifact caches while
running their checks. Swift formatting still uses Nx caching, keyed by the
runner's `swift --version` stdout and handwritten inputs; emitter-owned Swift
is excluded. Local native checks execute sequentially.

A developer pass satisfies a cacheable hosted check only when all of its
execution-sensitive inputs match.

A manual dispatch starts every lane, still cached. `fresh=true` sets
`NX_SKIP_REMOTE_CACHE=true`: each runner starts with an empty local cache and
reuses prerequisites it just built, avoiding repeated WASM compilation. Fresh
results do not read or write the remote cache.
This is separate from `purchase-import=true` and `live-email=true`; live
evaluations never start merely because a run is manual or fresh. Manual
aggregation is named `Manual CI diagnostics`, not the required PR check.

The remote cache is `apps/nx-cache`, a Worker backed by R2, using Nx's supported
HTTP cache client. CI and local setup connect only when both cache credentials
are present and its health request succeeds. Fork PRs receive no credentials;
a cache outage falls back to real checks rather than failing on a remote-cache
transport error. Cache failures never constitute passes. The bucket expires
entries after 30 days. Rotate `CACHE_TOKEN` in the Worker and update the Actions
`NX_CACHE_TOKEN` secret together. Treat write credentials as trusted check
publishers. Browser and native compiler caches are separate from Nx result passes.

The Worker's public root is an aggregate dashboard; `/stats.json` returns its
fixed last-24-hour snapshot. `/reports/` is a public read of the bucket's
`reports/` prefix, for CI test reports holding only synthetic data; uploads
require the bearer credential and set each file's content type. Cache archive
routes require the credential. Only authenticated cache operations write `cubby_nx_cache` Analytics
Engine events: outcome, GET/PUT method, artifact bytes and operation duration.
No hash, archive, terminal output, request identity or credential is recorded.
`GET /healthz` checks Worker reachability and authentication without touching
R2; it does not certify R2 availability. CI requires HTTP 204 from this
endpoint before connecting Nx to the remote cache.

The Analytics SQL binding queries fixed aggregate statements, automatically
weighting sampled events. The public UI distinguishes no activity from query
failures, preserves the previous view on refresh failure and retries on demand.
Successful snapshots are cached per edge for 60 seconds, partial failures for
10 seconds. Analytics errors never change a cache GET/PUT result.
Read hit rate excludes errors and probes. Bytes offered sums artifact sizes
returned to readers, not completed downloads; operation latency ends when the
R2 binding returns, before the download stream finishes. Upload latency includes
consuming the request body. Build time saved and transfer speed are not inferred.
R2 storage uses hourly maxima from `states.r2CombinedStorage`, with the
observation hour shown; these delayed observations are not an exact live tally.

cf provisions the `EVENTS`, `ANALYTICS_SQL` and static `ASSETS` bindings
with the existing cache Worker deployment. Analytics SQL requires the account's
Analytics Engine entitlement; it uses the Worker's account scope without an
additional API secret. Statistics start at deployment, without backfilling
historical requests. Local Vite serves the page and cache but reports
`ANALYTICS_SQL needs to be run remotely`; use the package tests for synthetic
analytics coverage and hosted binding queries for live metrics.

Use the supported Nx CLI and existing Actions. Do not derive hashes or inspect
archive internals with private Nx APIs. `nx affected` selects candidates;
it does not establish a passing result.

## Deployment reuse

The web deployment job supplies the same Nx cache credentials as CI. Its
`wasm: restore` setup restores the complete content-keyed worker, browser and
cookbook packages, with a real build on a miss or unavailable cache. The cache
Worker's own deployment does not depend on itself. Web compilation stays fresh
for the merged commit: it embeds source identity and uploads source maps, so a
PR's Build Output cannot simply be deployed as main. Current-main checks remain both
before build and before publication.

Sentry owns browser and Worker source-map uploads. The SSR build explicitly
emits maps. Client maps are deleted after Sentry's upload; server maps remain
in the Build Output Worker bundle for diagnostics, outside the public asset directory.
The build excludes sourcemap entries from the native Build Output manifest to
avoid a duplicate Cloudflare upload that exceeds its compressed map limit.

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

`pnpm apple check` runs lint, prepares artifacts, then executes selected native
checks sequentially. `apple:host-tests` runs CubbyKit's package tests, including
the shared operation transport contract; `apple:simulator-build` compiles
`Cubby-iOS` for a generic simulator. Neither boots a simulator. `apple:lint` runs Swift formatting
without Xcode. Missing Xcode fails native builds.
The `rust` target runs fmt/clippy/test per
crate (`recipebridge/project.json`, `cubby-ffi/project.json`, and
`cookbook-wasm/project.json`; the thin EPUB adapter only needs fmt/clippy). Clippy and tests
use the root workspace's `ci` profile: no debuginfo, incremental compilation,
or dependency optimization. These tests run in under a second; the development
profile's optimized dependencies add compilation work without useful runtime savings.
Cargo still needs check metadata and linked test artifacts, and the default
and browser/native feature sets remain separate checks. The targets share
`target/ci` and run sequentially to avoid Cargo's target-directory lock.
Their `rustGate` inputs include the root profile and workflow; `rustc -V`
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
the separate wasm-only sibling `cookbook-wasm` crate. `cubby-ffi` turns off
`recipebridge`'s default features and never enables `wasm`, so Apple targets
compile neither Worker-only capabilities nor WASM binding dependencies.
The browser uses `--no-default-features --features wasm`; the Worker enables
`wasm` alongside the default capabilities. The Rust gate checks both WASM
bindings and the plain native core; `cookbook-wasm:rust` owns the EPUB adapter's
formatting and Clippy checks.

`scripts/ensure.ts` dispatches to `scripts/wasm.ts` and `scripts/apple-ffi.ts`.
Their artifact keys hash reachable normal/build dependencies from Cargo's
resolved graph, local dependency contents, root workspace profiles and inherited package/lint settings,
Cargo configuration, compiler/tool versions, and build-affecting environment.
Development-only dependencies and unrelated workspace crates do not enter an
artifact's graph. All target conditions remain included so cross-compilation
retains host build-script and proc-macro dependencies. Resolved features are
conservatively unified by Cargo metadata across the workspace. Nx uses this
same fingerprint instead of independently hashing the entire lockfile or
workspace; the Apple marker fast path includes those same profile settings.
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

Host and simulator jobs from independent runs may execute concurrently on
separate hosted VMs, subject to GitHub's account-wide capacity. They have no
repository-wide lane queue: serializing unrelated PRs would leave available
macOS capacity unused. Workflow concurrency still cancels superseded PR
revisions and lets an active main push finish before the next main push starts.
The host job runs the automatically generated
`CubbyKit-Package` scheme with `xcodebuild test` on the ARM macOS host — no
simulator. The aggregate package scheme includes all CubbyKit tests and the CLI
product; the library-only `CubbyKit` scheme has no test action. The command uses
`-onlyUsePackageVersionsFromResolvedFile` to keep the committed package pins.
Its `xcode-host-v1` cache stores `apps/apple/CubbyKit/.build`, including the
Xcode compilation cache under `.build/xcode`. Package checkouts use the shared
`apps/apple/SourcePackages` clone cache that the simulator job saves. Xcode's
`Build` and `Logs` directories are excluded: tests rebuild products from cached
compiler results rather than restoring timestamp-sensitive objects and test
bundles. Keys include the Xcode toolchain, package pins and CubbyKit sources.
Native models are produced by `pnpm generate`, which rejects unsupported wire
shapes. Host tests exercise their actual encoding and decoding, including
omitted/null/value and unknown variants. The simulator job restores its simulator-only FFI framework and
runs the generic-simulator build with no tests or simulator boot. Both jobs
use `!cancelled()` so whole-workflow cancellation can stop them.

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
`apple:simulator-build`. It executes the build using the compiler/artifact caches
above rather than restoring an app from an Nx result pass. Check those callers
when removing a shared build helper.

The earlier simulator-test job ran `xcodebuild test` on a concrete simulator:
first boot cost about 6 minutes plus roughly 10 minutes of CPU starvation
(a 5s script took 2.6 minutes, and compilation doubled). Host tests and the
generic-simulator app build keep that simulator work excluded.
`.github/actions/setup-apple` is the native setup every macOS job uses: Xcode
selection, optional workspace installation, FFI slices, Apple tools, and
optional simulator DerivedData restoration.
`.github/actions/start-native-postgres` starts the macOS
E2E jobs' PostgreSQL, which cannot run service containers.
`setup-apple` installs XcodeGen and restores
`apps/apple/SourcePackages`, the `xcodebuild`-resolved SPM clones for Sentry,
GRDB, Nuke and HTTPTypes (previously an uncached "Resolve Package
Graph" on every run), used by both native jobs; `Apple host tests` skips
XcodeGen. The clone cache is separate from the target-specific FFI output cache and the
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
restore, and a PR saves only on a full miss. A native miss or deliberate
compilation on `main` publishes `main`'s entries. GitHub cache
entries are immutable: an interrupted compile saved under the final key makes
later exact hits repeat unfinished work. Cache-generation names and keys belong
in the setup actions. Retire obsolete generations and merged PRs' private entries
with GitHub's cache controls after main is seeded; retain active PR/current main
entries. Dependency clones remain advisory; warm restores establish reuse,
not a required-check runtime guarantee.

## Hosted suite

The `CI` workflow runs automatically for pull requests to `main` and pushes to
`main`. Superseded PR runs are canceled; a PR's run finishes after a merge.
Main runs finish rather than being canceled by later merges, so native checks
can publish reusable caches. GitHub concurrency keeps one main run active and
at most one pending; a newer push replaces the pending run. The newest main CI
result may wait for the active run; deployment remains independent.

`Plan` runs on the `ubuntu-slim` container runner and only path-filters the
Rust and Apple lanes with `dorny/paths-filter`: a pull request against its
base, a push against its `before` commit. Its filters are inline in `ci.yaml`.
The Apple filter names native sources and the files the Apple tasks read
directly, not the generator's web inputs: a change that only alters the
generated Swift client (a contract or schema edit) skips the Apple lanes, and
the nightly run catches a native break it causes. Nightly and manual runs start
both.

`CI passed` is the single required check (`re-actors/alls-green` on
`ubuntu-slim`). It needs every lane and fails on any failure or cancellation,
and on any skip other than a lane `Plan` did not select. A manual dispatch with `live-email=true` also runs the
informational live Email decisions outside `CI passed`, calling Jev and Clef on
synthetic cases through the real gateway with `AI_GATEWAY_API_KEY` (passed only
to that step). Failures do not block the deterministic merge gate. Real member
inputs are refused in CI.

`Validation and docs` installs the workspace and runs the cached generate,
design-token, types, lint, Knip, bindings, Swift lint and format targets, then
the offline relative-link check, as individual steps. It runs no tests; every
Vitest suite runs in the Vitest shards. `pnpm check:all` runs those targets and
the fast web `test` target locally. It stays a separate job rather than part of
`Plan`: `Plan` gates the Rust and Apple lanes on a 1-vCPU runner, so the static
checks there would delay them and run several times slower.
Dependency advisory audits and deduplication are not CI or local validation
gates; dependency maintenance is handled separately from code validation. The
link check runs through the pinned Lychee action, a composite action that
downloads the Lychee binary (no Docker). Paths written as inline code are
informational; link a repository file when its existence should be checked.

`setup-node-with-deps` installs from the registry without a pnpm store cache:
measured restore/save cost exceeded fresh install cost. With `wasm: restore`
it replays Nx's WASM artifact from R2, outside the Actions cache, and builds
with the runner's Rust only on a miss. Compiler and SwiftPM caches are separate.

Generated output is never committed; web and Apple jobs generate it during
`postinstall`. The Rust job's root-only install skips web generation, and
`Validation`'s `generate` gate checks that declarations generate cleanly,
including the direct native contract and Swift codecs.

The `lanes` job is one static matrix with browser and Vitest sharding.
The workflow owns the shard counts; worker counts per runner stay unchanged.
Browser shards run alone, so no companion check waits behind one. Every
failure still fails the job and `CI passed`, and each Nx target retains its own
cache key.

Each entry uses one runner from its assigned provider with PostgreSQL and IntegreSQL service
containers.
Each Vitest shard runs the `vitest-ci` target: one Vitest run of every merge-gate
project (`unit`, `mcp-contract`, `ui`, `capability`, `scripts`,
`packages`, `integration`, `integration-workerd` and `workers`), split by file
with `CUBBY_VITEST_SHARD`. Vitest assigns files to shards by path hash, so the
split does not follow duration. Project groups run in order within a shard,
so PostgreSQL forks never start beside workerd. The target builds the Worker
itself for `integration-workerd`. Shard 2 then runs the `db-check` migration
drift check against disposable scratch databases, which runs despite a test
failure. Service-backed projects (`integration`, `integration-workerd`,
`capability`, `workers`) retry a failed test once on CI; Node unit, tooling and
package projects never retry.
Desktop Chromium runs as Playwright shards (two workers each) through the
`e2e` target, each restoring or building the Worker with the run's source commit and branch
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
traces for seven days, named by commit SHA and shard, and a blob report.

`Test report` waits for Validation and the test lanes (not Rust or Apple),
downloads the Vitest and Playwright blobs,
and merges each runner's shards into one HTML report (`vitest --merge-reports`,
`playwright merge-reports`). It publishes both to the Nx cache Worker, which
serves them publicly at `/reports/{run}/{attempt}/{vitest|playwright}/`, and
also uploads them as 14-day artifacts. The workflows set `NX_CACHE_URL`, the
Worker's public origin, as a plain value rather than a secret: Actions withholds
step outputs containing a secret, which would drop the report links. Only
`NX_CACHE_TOKEN` is secret; fork PRs lack it and fall back to the artifacts.
(Vitest Viewer cannot open Actions artifact URLs: they require a signed-in
browser and block cross-origin reads.) The job
summary (`apps/web/tooling/ci-report/summary.ts`) lists each Linux test lane's
result and duration from the Actions API, shard balance, per-runner totals, failures,
tests that passed only on retry, and the slowest tests. It is informative and
outside `CI passed`, so merging never delays or fails the gate. CI runs use only
synthetic data and test credentials, so the report is safe to publish. Local
runs, including the manually dispatched native simulator E2E, keep their
reports, traces, and run bundles local because they may contain household data
or credentials.
`E2E tests (purchase import agent, optional)` runs the Playwright project of
that name (`purchase-import-run.spec.ts`: the purchase agent with a scripted
model and gateway, driven through the browser) through the
`e2e-purchase-import` target, restoring or building its Worker before testing. It is informative only:
it is outside `CI passed` and `continue-on-error`, so its failure leaves the run
successful. It uses the same `webGate` key as the
other web lanes and uploads the same Playwright report.
The `integration` Vitest project runs once through the `postgres` target
with four fork workers; local explicit partitions remain supported and separately keyed. The
`integration-workerd` project (the files that start the built Worker, listed in
`workerdIntegrationTests` in `apps/web/vitest.config.ts`) runs in `Build
Workers and runtime tests`. Keep every Worker-consuming integration test in
that project explicitly. The harness's refusal to rebuild missing or
stale Workers in CI does not enforce project membership. Jobs that need the databases
declare native GitHub Actions service containers; a YAML anchor reuses the
pgvector PostgreSQL and pinned IntegreSQL definitions. GitHub owns the network, container
startup, PostgreSQL health wait, logs, and cleanup. PostgreSQL also maps port
55432 for guarded named-database tests, on loopback only: 55432 is inside
Linux's ephemeral port range, and an all-interfaces bind failed container
startup when an outgoing connection held it. `POSTGRES_INITDB_ARGS` sets the disposable
settings in the fresh PostgreSQL 17 configuration. IntegreSQL retries its
PostgreSQL connection during startup; its pinned distroless image has no
`/bin/sh` for Docker shell health checks. The optional purchase-import lane
uses the same service definitions. The
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
with the existing runner, then run `cf deploy --prebuilt --mode production`
against `.cloudflare/output/v0/`. The Cloudflare Vite plugin v2 builds this
output from `cloudflare.config.ts`. It checks
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
cache change. It uses a filtered install and the package's `cf deploy` command on
`ubuntu-slim`; cf builds the Vite Worker and its `public/` dashboard assets
before deploying, with no separate workflow build step. Both workflows keep credentials in
the deployment step's environment and serialize their own service deployments.

## Branch protection and measurement

The `main` ruleset requires only `CI passed`, from GitHub Actions. Keep `strict` disabled so
a green non-conflicting branch need not rebase, allow administrator bypasses,
and do not require human review.

Optimize readiness across concurrent PRs within both providers' available slots.
The Linux `lanes` matrix sets no `max-parallel`, so all entries can run
concurrently when capacity permits; validation and short control jobs are additional demand, and
optional work has repository-level limits. The browser shard count is reduced from the doubled-shard experiment while
retaining the expanded Vitest split, and half of each tier uses each provider.
Standalone shards pay setup on every runner; this does not reserve
account-wide capacity or guarantee fairness against unrelated repositories.

Use the Actions job timeline to distinguish created-to-start waiting, setup,
job duration and Nx cache replay. Compare
readiness p50/p95 and total job-minutes when a tradeoff is unclear, but do not
hold a clear improvement for a fixed sample quota. Warm, cold and environment
changes are different populations. Native historical nightly/dispatch runs are
valid setup/build evidence; PR samples whose Mac jobs all skipped say nothing
about cold native queueing. The ordinary changed-code PR goal is a five-minute
p50, with p95 and cold/native runs measured separately. Prefer fewer runners
and runner-minutes within that budget; a substantial resource saving can
justify moving toward six minutes. These are targets, not measured guarantees.
Optional purchase import starts only after required CI succeeds and
uses one repository background slot. Superseded PR revisions cancel; sibling
failures do not cancel independent checks. Rust formatting, Clippy and tests
collect results separately, and Playwright has no failure-count cutoff; setup
failures and existing timeouts still bound impossible or stuck runs.

### Retained experiment conclusions

Individual correctness cases should target single-digit seconds. Report module
collection and fixture startup separately from scenario execution; splitting a
long scenario into cases does not establish less total work. Keep the existing
HTML reports and compare natural CI runs before changing worker counts.
Development database collection safety remains in
`tooling/dev/corpus-template.integration.test.ts`: connected databases, explicit
names, the requested target and reused ownership retain their checks. The cold
corpus clone/auth/search/image, refresh-intent and checkout-edit-retention case
is deliberately omitted, alongside the full-corpus graph, chronology, reseed
and native-QA sweep. These rare development bootstrap contracts no longer have
dedicated automated coverage. Shared populated
list capability checks own presentation, with one focused Project column-build
regression instead of rendering empty tables for every entity. Run slot
declarations are exercised by the retained import/photo browser workflows,
rather than a unit matrix repeating slot names and predicates.

Collect naturally occurring successful PR runs before claiming a new median.
Compare queue time, required-check p50/p95, cache misses, cancellations,
job-minutes, and merge-to-deploy time. Historical experiment tables and run
links remain in Git history.

- More browser workers increased navigation latency and cumulative case time
  without a reliable critical-path gain. Shard counts and worker settings live
  in the workflows and Playwright configuration.
- Fast projects share a job to reduce runner demand outside the browser
  critical path. Browser and workerd checks prepare their own Worker, reusing
  compatible completed Nx builds. The shared producer experiment added a
  prerequisite and artifact transfer without demonstrating faster readiness;
  the hybrid experiment restores independent builds.
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
- `vitest doctor` (local, non-PostgreSQL projects, one run each) favoured
  `isolate: false` (−14%) and more workers. The worker gain needs more cores
  than a hosted runner has. The former isolated `worker-safety` catalog smoke
  check is removed: `mcp-worklist.spec.ts` exercises the same catalog
  introspection inside the real built Worker. Both smoke checks list tools;
  neither compiles tool-output validators, which the SDK does on `callTool`.
  They do not establish validator code-generation coverage. Only the
  `workers` project measured a reliable per-project gain (21 s to 9 s), and
  `scripts`/`packages` stayed within noise. `vmThreads`/`vmForks` fail the
  process and file-system tooling tests.

## Operational checks

Attribute slow browser work separately to document response, script loading
and execution, hydration, client navigation, and the first actionable result.
Use [Playwright's hydration guidance](https://playwright.dev/docs/navigations#hydration)
and [TanStack's loading lifecycle](https://tanstack.com/router/latest/docs/guide/data-loading)
before changing readiness or loader boundaries. Router intent preloading and
Query-owned freshness are already configured; full-document navigation starts
another client app and cannot reuse the previous document's Query cache.

For Worker initialization, follow the [startup profiling procedure](infrastructure.md).
For request CPU, use the
[Worker profiler](https://developers.cloudflare.com/workers/observability/dev-tools/cpu-usage/):
Worker timers advance on I/O and do not isolate synchronous CPU cost. Keep
Node-side harness timing separate from Worker CPU, database time, and browser
hydration. These are diagnostics, not additional required CI checks.

Choose workflow/routing checks under the
[validation policy](agents/validation.md#before-opening-a-pr); workflow edits
use `actionlint` without asking for a broad local suite.

Use naturally occurring runs to compare PR wall time, queueing, job-minutes,
and cache behavior. Ship verified improvements without a sampling quota;
measure before claiming a particular speedup.

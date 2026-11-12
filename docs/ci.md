# Continuous integration

This page owns how hosted CI, its caches and deployment work. What an agent
runs locally lives in the [validation policy](agents/validation.md) and the
[quality guide](agents/validation-quality.md).

Every required check is an Nx target. Cacheable targets' `inputs` decide their
cache keys; a passing result for the same key in the shared Nx remote cache
replays in seconds and satisfies the merge gate
([ADR 0009](adr/0009-content-hash-merge-gate.md)). Every Linux lane starts on
every run and lets that cache skip unchanged work; only the Rust lane and the
Apple lanes are path-filtered ([ADR 0020](adr/0020-cache-routed-ci.md)).
Selected Apple host and simulator checks always execute on macOS, using
ordinary compiler and artifact caches. Merging to `main` independently deploys
the web Worker, including after a documentation-only change; deployment never
waits for post-merge CI.

`ci.yaml` holds the required checks and informational jobs: the purchase-import
browser after relevant import changes or explicit manual opt-in, and live Email
decisions only with the separate manual opt-in. Validation exposes generation,
tokens, TypeScript, lint, Knip, bindings, tooling tests, Worker tests, Swift
lint, formatting and the link check as named steps on one runner. Once setup
succeeds, independent steps run despite earlier check failures; their failures
still fail the job. Cancellation stops further work. The web matrix likewise
keeps `fail-fast: false`, collecting distinct failures without a fresh install
per static check. One status context, `CI passed`, owns the merge gate.
[Journeys](#journeys) live in their own workflow.

The offline relative Markdown link check downloads lychee with
`gh release download` and the job's read-only token. Its Linux archive version
and SHA-256 are pinned together in `ci.yaml`; update both when changing the
checker. The checksum must pass before extraction or execution, and a download
failure is a check failure rather than a skip. Paths written as inline code are
informational; link a repository file when its existence should be checked.

The required test matrix runs on GitHub-hosted runners: four browser shards and
four Vitest shards on `ubuntu-latest`, with two browser workers per shard. Every
shard restores or builds its own web output through Nx; the content-keyed
`build-cf` is the only staleness check, and there is no shared-build producer
or artifact prerequisite between shards. Plan, reporting and the final gate use
`ubuntu-slim`. Rust keeps its ARM runner and Apple checks their macOS runners.

`.github/actions/setup-playwright` shares an exact-version Chromium headless
shell cache between Vitest's component-browser tests and E2E, stored under the
ignored workspace-local `playwright/.cache/ms-playwright`. A hit reuses binaries;
a miss installs only headless shell and its required helpers. Required suites
run headlessly without branded channels; GitHub's Ubuntu image supplies the
browser's operating-system libraries.

Standard GitHub-hosted runners are free for this public repository. Account
capacity still affects readiness: GitHub Pro permits 40 concurrent hosted jobs,
with a separate maximum of five macOS jobs. Compare full push-to-gate time,
queueing, setup and actual test execution; a cached test replay measures
different work from executing changed-code tests.

## Journeys

Simulator journeys live in `journeys.yaml`, outside the merge gate. The
`simulator-e2e` label on a same-repository PR starts the deterministic simulator
journey on the PR head and subsequent pushes. Manual dispatch selects
`simulator-search` or `simulator-inputs` on the dispatched ref. Unlabeled
changes, `main` pushes and nightly runs start neither. Relabeling or
redispatching cancels the older run. Native journeys restore SPM and DerivedData
caches before their build and take macOS slots beyond the required Apple checks.
`.github/actions/start-native-postgres` starts their PostgreSQL, since macOS
jobs cannot run service containers.

## Cache keys and the remote cache

Ordinary PR, main, nightly and manual runs reuse valid Nx results. A nightly
starts every filtered lane; it does not disable caches. It catches what path
filters and declared toolchains miss without rebuilding unchanged targets
merely because a day elapsed.

Result passes certify source inputs **and** execution identity. Web/test gates
include Node, platform/architecture, the hosted image version, CI mode, locale
and timezone, each as a plain Nx `env` or `runtime` input. A runtime input's
command must print only deterministic stdout: Nx hashes stdout and stderr. Web
targets add ignored env files, generated WASM and the selectors in
`apps/web/project.json`; shard selection is keyed per target and browser worker
count is fixed at two in the target command. The Worker bundles all
`docs/**/*.md`, so those bytes participate in runtime keys. Native App source is
excluded only from web-specific passes; root tooling keeps broad coverage. Rust
checks include their actual compiler, platform and Cargo warning policy; CI sets
`CARGO_BUILD_WARNINGS=deny` for native compilation. Portable generation and WASM
artifacts keep their own narrower, content/toolchain-based inputs. Generation
outputs outside the standard generated directories must be listed in
`cubby-checks:generate.outputs`, including the bootstrap definition catalog
beside the entity declarations. A cache replay must restore these on a clean
checkout; a warm local copy is not evidence that the artifact is cached.

Apple host tests and simulator builds do not cache result passes; they use
Xcode, SwiftPM and Cargo artifact caches. Swift formatting still uses Nx
caching, keyed by the runner's `swift --version` stdout and handwritten inputs;
emitter-owned Swift is excluded. A developer pass satisfies a cacheable hosted
check only when all of its execution-sensitive inputs match.

A manual dispatch starts every lane, still cached. `fresh=true` sets
`NX_SKIP_REMOTE_CACHE=true`: each runner starts with an empty local cache and
reuses prerequisites it just built, avoiding repeated WASM compilation; fresh
results neither read nor write the remote cache. To time web test execution
with ordinary build-cache reuse, dispatch `fresh-tests=true` instead: Vitest
and Playwright bypass remote results while installation, WASM, the web build
and other checks keep their caches. `fresh=true` overrides it. These are
separate from `purchase-import=true` and `live-email=true`; live evaluations
never start merely because a run is manual or fresh. Manual aggregation is
named `Manual CI diagnostics`, not the required PR check.

The remote cache is `apps/nx-cache`, a Worker backed by R2, using Nx's supported
HTTP cache client. CI and local setup connect only when both cache credentials
are present and its health request succeeds. Fork PRs receive no credentials;
a cache outage falls back to real checks rather than failing on a remote-cache
transport error. Cache failures never constitute passes. The bucket expires
entries after 30 days. Rotate `CACHE_TOKEN` in the Worker and update the Actions
`NX_CACHE_TOKEN` secret together. Treat write credentials as trusted check
publishers. Browser and native compiler caches are separate from Nx result
passes.

The Worker's public root is an aggregate dashboard; `/stats.json` returns its
fixed last-24-hour snapshot. `/reports/` is a public read of the bucket's
`reports/` prefix for CI test reports holding only synthetic data; uploads
require the bearer credential and set each file's content type. Cache archive
routes require the credential. Only authenticated cache operations write
`cubby_nx_cache` Analytics Engine events: outcome, GET/PUT method, artifact
bytes and operation duration. No hash, archive, terminal output, request
identity or credential is recorded. `GET /healthz` checks Worker reachability
and authentication without touching R2; CI requires HTTP 204 from it before
connecting Nx to the remote cache.

The dashboard's Analytics SQL binding queries fixed aggregate statements over
those sampled events; analytics errors never change a cache GET/PUT result, and
the dashboard reports query failures separately from no activity. Bytes offered
counts artifacts returned, not completed downloads, and R2 storage figures are
delayed hourly maxima. cf provisions the `EVENTS`, `ANALYTICS_SQL` and `ASSETS`
bindings with the cache Worker; Analytics SQL needs the account's Analytics
Engine entitlement and works only remotely, so local coverage uses the
package's synthetic tests.

Use the supported Nx CLI and existing Actions. Do not derive hashes or inspect
archive internals with private Nx APIs. `nx affected` selects candidates; it
does not establish a passing result.

## Deployment reuse

The web deployment job supplies the same Nx cache credentials as CI. Its
`wasm: restore` setup restores the complete content-keyed worker, browser and
cookbook packages, with a real build on a miss or unavailable cache. The cache
Worker's own deployment does not depend on itself. Web compilation stays fresh
for the merged commit: it embeds source identity and uploads source maps, so a
PR's Build Output cannot be deployed as main. Current-main checks run both
before build and before publication.

Sentry owns browser and Worker source-map uploads. The SSR build explicitly
emits maps. Client maps are deleted after Sentry's upload; server maps remain
in the Build Output Worker bundle for diagnostics, outside the public asset
directory. The build excludes sourcemap entries from the native Build Output
manifest to avoid a duplicate Cloudflare upload that exceeds its compressed map
limit.

## Local verification

`pnpm verify:local` mirrors the hosted graph sequentially (`--parallel=1`):
every tier already parallelizes internally, and running tiers side by side on
one host causes contention and test timeouts. Its target order is not
dependency order; Nx supplies prerequisites (WASM before consumers, web build
before E2E). Two simultaneous full verifications on one machine are not
resource-safe.

Toolchain versions come from `.nvmrc`, the root `packageManager`,
`rust-toolchain.toml`, and the Apple setup action. Rust/wasm-pack, Apple
`container` on macOS (external PostgreSQL/IntegreSQL on Linux), and Playwright
browsers must be available. Playwright defaults to one worker on hosted runners
and two on local macOS (`playwright.config.ts`); the `e2e` target passes its
configured count per shard. Both test tiers reject an empty selection or an
unexpected skipped test without freezing the suite to a hand-maintained count;
a Vitest `-t` run accepts tests the pattern left out but fails when the pattern
matches nothing or a matched test is skipped.

The web build ensures current WASM and generated contracts before bundling, and
native CLI, test and app commands ensure generated contracts before
compilation; artifact freshness belongs to these consumers, not Git hooks.

## Rust lane

The `rust` target runs fmt/clippy/test per crate (`recipebridge/project.json`,
`cubby-ffi/project.json` and `cookbook-wasm/project.json`; the thin EPUB adapter
only needs fmt/clippy). Clippy and tests use the root workspace's `ci` profile:
no debuginfo, incremental compilation or dependency optimization, since these
tests run in under a second. The default and browser/native feature sets stay
separate checks. The targets share `target/ci` and run sequentially to avoid
Cargo's target-directory lock. Their `rustGate` inputs include the root profile
and workflow; `rustc -V` keys the floating compiler.

The Rust job uses a pinned `Swatinem/rust-cache` step with prefix `rust-gate-v3`;
its key also hashes root `Cargo.toml`, because rust-cache omits the virtual
workspace's profiles. The job installs only the root workspace
(`workspace-filter: cubby`), which provides Nx without the web packages or their
generator. Nx targets compile their own dependencies; do not add a separate
pre-Nx Clippy or `cargo test --no-run` pass, which repeats that compilation even
when Nx already has a passing result. Only successful jobs save compiler-cache
entries; a small cache saved by a fully replayed job affects later speed, not
the validity of Nx's pass.

`cubby-ffi` and the WASM packages share the `recipebridge` Rust core and Cargo
lockfile, but each target needs its own artifacts. EPUB extraction is the
separate wasm-only `cookbook-wasm` crate. `cubby-ffi` turns off `recipebridge`'s
default features and never enables `wasm`, so Apple targets compile neither
Worker-only capabilities nor WASM binding dependencies. The browser uses
`--no-default-features --features wasm`; the Worker enables `wasm` alongside
the defaults. The Rust gate checks both WASM bindings and the plain native core;
`cookbook-wasm:rust` owns the EPUB adapter's formatting and Clippy.

`scripts/ensure.ts` dispatches to `scripts/wasm.ts` and `scripts/apple-ffi.ts`.
Their artifact keys hash reachable normal/build dependencies from Cargo's
resolved graph, local dependency contents, root workspace profiles and inherited
package/lint settings, Cargo configuration, compiler/tool versions, and
build-affecting environment. Development-only dependencies and unrelated
workspace crates do not enter an artifact's graph. All target conditions stay
included so cross-compilation keeps host build-script and proc-macro
dependencies; resolved features are conservatively unified across the
workspace. Nx uses this same fingerprint instead of hashing the whole lockfile,
and the Apple marker fast path includes the same profile settings.

## Apple lanes

`pnpm apple check` runs lint, prepares artifacts, then executes selected native
checks sequentially. `apple:host-tests` runs CubbyKit's package tests, including
the shared operation transport contract; `apple:simulator-build` compiles
`Cubby-iOS` for a generic simulator. Neither boots a simulator: hosted CI never
runs tests on a concrete simulator, whose boot and CPU starvation cost many
minutes per run. `apple:lint` runs Swift formatting without Xcode. Missing Xcode
fails native builds.

Locally, `xcodebuild test -scheme Cubby-iOS` on a simulator also runs
CubbyKit's tests (a package test target in `apps/apple/project.yml`); hosted CI
does not use it. The `.requiresVisionHardware` trait skips Vision-dependent
contracts (`SubjectLift`, `FeaturePrintIndex`) on the Simulator.

Host and simulator jobs from independent runs may execute concurrently on
separate hosted VMs, subject to account capacity; there is no repository-wide
lane queue. Workflow concurrency still cancels superseded PR revisions. The
host job runs the generated `CubbyKit-Package` scheme with `xcodebuild test` on
the ARM macOS host, with `-onlyUsePackageVersionsFromResolvedFile` to keep the
committed pins; the library-only `CubbyKit` scheme has no test action. Its
`xcode-host-v3` cache stores only
`apps/apple/CubbyKit/.build/xcode/CompilationCache.noindex`; SwiftPM outputs
under `.build` belong to the local CLI build. Xcode's `Build` and `Logs`
directories are excluded, so tests rebuild products from cached compiler
results rather than restoring timestamp-sensitive objects. Keys include the
Xcode toolchain, package pins and CubbyKit sources. Native models come from
`pnpm generate`, which rejects unsupported wire shapes; host tests exercise
their encoding and decoding, including omitted/null/value and unknown variants.
The simulator job restores its simulator-only FFI framework and runs the
generic-simulator build with no tests. Both jobs use `!cancelled()` so
whole-workflow cancellation can stop them.

Each SDK keeps its own compilation cache, and the two jobs use separate macOS
slots so their compile times do not add after a cache miss. A generated-schema
change still recompiles the client for each SDK. The generated `CubbyAPI` target
forwards `-gline-tables-only` directly to the Swift frontend, so the driver's
default `-g` does not restore full debug type information; handwritten targets
keep normal debug information. Both `xcodebuild` commands enable Apple's
compilation cache and its remarks on the command line, so SwiftPM package
targets (`CubbyAPI`, `CubbyKit`) use it too; results live in
`DerivedData/CompilationCache.noindex` (simulator) and
`CubbyKit/.build/xcode/CompilationCache.noindex` (host). This replays compiler
work when products need rebuilding but compiler inputs are unchanged. CI bounds each compiler cache to 1 GB; local Xcode builds retain 10 GB. Only
content-addressed compiler results cross runners, not DerivedData products,
precompiled module directories or workspace state. Local `swift test` does not
use this cache.

Manual native E2E (`apps/web/tooling/sim-e2e.ts`) also runs
`apple:simulator-build`; check it when removing a shared build helper.

`.github/actions/setup-apple` is the native setup every macOS job uses: Xcode
selection, a workspace installation filtered to the root and web tooling for
native contract generation, FFI slices, Apple tools,
XcodeGen (skipped by `Apple host tests`) and optional simulator compilation-cache
restoration. Rustup prepares the repository's compiler before computing the
FFI fingerprint; an exact FFI-output hit skips target-library installation and
Cargo build-cache transfer. The fingerprint retains the compiler identity,
resolved Cargo graph, local source bytes, build environment, Xcode, targets and
profile. Archive jobs can run this preparation without installing JS dependencies.

It restores `apps/apple/SourcePackages`, the `xcodebuild`-resolved SPM clones
used by app builds; the host resolves its smaller package graph directly.
That clone cache is separate from the FFI output cache and compiler caches. Simulator compiler keys include the Xcode toolchain,
package declarations, both resolved-pin files, generated FFI headers, app and
Kit sources, and build tooling. Partial restores require the same package graph.
App pins live in `apps/apple/Package.resolved` and Kit pins in
`apps/apple/CubbyKit/Package.resolved`; dependency declarations live in
`apps/apple/packages.yml` and the local package manifest.

Compiled Apple caches are published only after successful work, through
`save-cache-main-only`: any run on `main` saves a new exact key over a partial
restore, and a PR saves only on a full miss. GitHub cache entries are
immutable, so an interrupted compile saved under the final key would make later
exact hits repeat unfinished work. Cache-generation names and keys belong in
the setup actions. Retire obsolete generations and merged PRs' private entries
with GitHub's cache controls after main is seeded; retain active PR and current
main entries. Warm restores establish reuse, not a required-check runtime
guarantee.

## Hosted suite

The `CI` workflow runs automatically for pull requests to `main` and pushes to
`main`. Superseded PR runs are canceled; a PR's run finishes after a merge.
Main runs finish rather than being canceled by later merges, so native checks
can publish reusable caches. GitHub concurrency keeps one main run active and
at most one pending; a newer push replaces the pending run.

`Plan` runs on `ubuntu-slim` and path-filters only the Rust and Apple lanes with
`dorny/paths-filter`: a pull request against its base, a push against its
`before` commit. Its filters are inline in `ci.yaml`. The Apple filter names
native sources and the files the Apple tasks read directly, not the generator's
web inputs: a change that only alters the generated Swift client skips the Apple
lanes, and the nightly run catches a native break it causes. Nightly and manual
runs start both.

`CI passed` is the single required check (`re-actors/alls-green` on
`ubuntu-slim`). It needs every lane and fails on any failure or cancellation,
and on any skip other than a lane `Plan` did not select. A manual dispatch with
`live-email=true` also runs the informational live Email decisions outside
`CI passed`, calling Jev on synthetic cases through the real gateway with
`AI_GATEWAY_API_KEY` (passed only to that step). Real member inputs are refused
in CI.

`Validation and docs` installs the workspace and runs the cached generate,
design-token, types, lint, Knip, bindings, Swift lint and format targets, then
the link check, as individual steps. It runs no tests; every Vitest suite runs
in the Vitest shards. `pnpm check:all` runs those targets and the fast web
`test` target locally. It stays separate from `Plan` because static checks on
that 1-vCPU runner would delay the Rust and Apple lanes. Dependency advisory
audits and deduplication are maintenance, not CI or local validation gates.

`setup-node-with-deps` installs from the registry without a pnpm store cache:
measured restore/save cost exceeded fresh install cost. With `wasm: restore`
it replays Nx's WASM artifact from R2, outside the Actions cache, and builds
with the runner's Rust only on a miss. Generated output is never committed; web
and Apple jobs generate it during `postinstall`. The Rust job's root-only
install skips web generation, and Validation's `generate` gate checks that
declarations generate cleanly, including the direct native contract and Swift
codecs.

### Test lanes

The `lanes` job is one static matrix with browser and Vitest sharding and no
`max-parallel`. The workflow owns shard counts; the e2e target fixes browser
workers. Browser shards run alone, so no companion check waits behind one.
Every failure still fails the job and `CI passed`, and each Nx target keeps its
own cache key. Each entry uses one runner with PostgreSQL and IntegreSQL service
containers.

Each Vitest shard runs the `vitest-ci` target: one Vitest run of every
merge-gate project (`unit`, `mcp-contract`, `ui`, `capability`, `scripts`,
`packages`, `integration` and `workers`), split by file with
`CUBBY_VITEST_SHARD`. Vitest assigns files by path hash, not duration. Project
groups run in order within a shard, so PostgreSQL forks never start beside
workerd. No Vitest project uses the built Worker, so Vitest shards skip the web
build; integration tests inject bindings with `setCfEnv`. Shard 2 also runs the
`db-check` migration drift check against disposable scratch databases, even
after a test failure. Service-backed projects (`integration`, `capability`,
`workers`) retry a failed test once on CI; Node unit, tooling and package
projects never retry.

Desktop Chromium is the only browser in PR CI and the Playwright suite; it runs
as shards through the `e2e` target, each restoring or building the
content-keyed Worker. Native checks are separate, and there is no coverage
mode. CI records a Playwright trace only for the retry of a failed test
(`on-first-retry`); local runs keep failure traces (`retain-on-failure`). Each
browser job uploads only its blob report, which carries the traces, for seven
days; `Test report` merges them. Each Vitest job uploads its `.vitest/`
directory (blob, attachments and browser-mode failure screenshots) as one path:
a recursive glob over `apps/web` walks `node_modules` and held each shard's
critical path for about 18 seconds.

The disposable PostgreSQL container uses `fsync=off`, `synchronous_commit=off`
and `full_page_writes=off` through `POSTGRES_INITDB_ARGS`, matching the local
test services ([non-durable settings](https://www.postgresql.org/docs/17/non-durability.html));
CI does not test crash recovery, while constraints, transactions and full reset
still run. Jobs that need databases declare native service containers; a YAML
anchor reuses the pgvector PostgreSQL and pinned IntegreSQL definitions.
PostgreSQL pulls its pinned digest directly from Docker Hub (the Google mirror
has returned `unknown blob` for it) and maps port 55432 for guarded
named-database tests on loopback only: 55432 is inside Linux's ephemeral range,
and an all-interfaces bind fails when an outgoing connection holds it.
IntegreSQL retries its PostgreSQL connection during startup; its distroless
image has no `/bin/sh` for Docker health checks. The `integration` project runs
once through the `postgres` target with four fork workers.

`E2E tests (purchase import agent, optional)` runs the Playwright project of
that name through the `e2e-purchase-import` target, restoring or building its
Worker first. It is informative only: outside `CI passed` and
`continue-on-error`. It uses the same `webGate` key and service definitions as
the other web lanes and uploads its own Playwright HTML report and traces,
because `Test report` does not wait for it.

### Test report

`Test report` waits for Validation and the test lanes (not Rust or Apple),
installs without postinstall generation, and merges every Vitest and Playwright
shard blob into one report (`vitest --merge-reports`, `playwright merge-reports`):
an index page linking the Vitest and Playwright HTML reports. It publishes that
directory to the Nx cache Worker, which serves it at `/reports/{run}/{attempt}/`,
and uploads it as a 14-day artifact. Uploads share an eight-request limit and
retry transient failures twice. Workflows set `NX_CACHE_URL` as a plain value
rather than a secret, because Actions withholds step outputs containing a secret
and would drop the report link; only `NX_CACHE_TOKEN` is secret, and fork PRs
fall back to the artifact. The job summary is Vitest's `github-actions`
reporter summary plus the report link; Playwright failures surface as `github`
reporter annotations on the shards. The job is outside `CI passed`. CI uses only
synthetic data and test credentials, so the report is safe to publish; local
runs, including the manually dispatched native simulator E2E, keep their
reports, traces and run bundles local.

The `@claude` mention workflow (`claude.yml`) runs on demand; a new mention on
the same issue or PR supersedes its previous response, while unrelated comments
do not cancel it. There is no automatic PR review workflow. Production is the
only deployed environment.

## Apple TestFlight release

Normal merges to `main` wait for the nightly check at 10:17 UTC. It publishes
current `main` when files that can reach the app changed since the last complete
upload (the workflow's inline `full`/`apple` path filters), or that upload is at
least 30 days old. `packages/shared/src/apple-client-version.ts` holds two
separate values. `APPLE_CLIENT_MINIMUM_VERSION` is the server's write gate;
changing it publishes promptly (comment-only edits do not) so a compatible
build exists. `APPLE_MARKETING_VERSION` supplies the generated
`MARKETING_VERSION` and must not be older than the minimum; releases need no
change to it because every upload gets a new build number. Never bump either
value to get a build out sooner: dispatch the workflow instead.

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

Uploads are internal-only with automatic group distribution. Upload success
does not mean the build is available yet. Server deployment remains immediate, so breaking
changes can leave an update-required period until the new app is installed.

After a long pause, manually re-enable scheduling and dispatch a fresh build.
GitHub can disable public-repository schedules after 60 inactive days; the
30-day refresh does not prevent this.

## Deployment

`.github/workflows/deploy.yaml` deploys the web Worker on every `main` push,
without waiting for post-merge CI. Required PR checks gate merging. It uses
`.github/actions/deploy-worker` to build once, apply committed production
migrations with the existing runner, then run
`cf deploy --prebuilt --mode production` against `.cloudflare/output/v0/`. The
bundle carries no commit: the action's `Record source release` step writes
`CUBBY_SOURCE_COMMIT` (short SHA), `CUBBY_SOURCE_BRANCH` and `CUBBY_SOURCE_DATE`
from `tooling/source-identity.ts`, and `--secrets-file` uploads them with the
Worker version while existing secrets are inherited. The Sentry plugin names and
uploads the build's maps as `cubby@<short SHA>` with `inject: false`, matching
the runtime release. The Cloudflare Vite plugin v2 builds this output from
`cloudflare.config.ts`. The action checks current main before building and
again after migration, before deployment, so a stale run finishes successfully
without publishing. Before production acceptance, verify the actual Worker
upload, trigger deployment and published version in the logs for a commit
containing the change. If the run was skipped as stale, follow the newer
release; a green workflow alone does not prove publication.

Keep build, migration and deployment as named steps in the existing action;
avoid standalone wrappers and multi-operation command inputs. Migration failure
blocks deployment. The migration and deploy share the existing non-cancelling
production concurrency group. The database credential is scoped to the
migration step; the Cloudflare credential is scoped to deployment.

Retry a failed release by manually dispatching `Deploy` on `main`; the runner
verifies and skips the already-applied migration prefix. If schema application
succeeds and deployment fails, the schema stays applied: roll forward with a
compatible deployment rather than resetting migration bookkeeping. Every push
must therefore be compatible with the code running before deployment. Staged
boundaries and breaking cutovers follow the
[production migration runbook](runbooks/production-migrations.md). Migrations
expected to exceed the deployment job's install/build/release time budget
belong on the operator-managed cutover path.

`.github/workflows/deploy-nx-cache.yaml` deploys the Nx cache only when its
source/configuration, dependency inputs, Node version, setup action, or its own
workflow changes. Manual dispatch can retry a deployment. It checks out current
`main` when the serialized job starts, so rerunning an old workflow cannot roll
the service back and a later docs-only push cannot suppress a pending cache
change. It uses a filtered install and the package's `cf deploy` command on
`ubuntu-slim`; cf builds the Vite Worker and its `public/` dashboard assets
before deploying. Both workflows keep credentials in the deployment step's
environment and serialize their own service deployments.

## Branch protection and measurement

The `main` ruleset requires only `CI passed`, from GitHub Actions. Keep `strict`
disabled so a green non-conflicting branch need not rebase, allow administrator
bypasses, and do not require human review.

Optimize readiness across concurrent PRs within the account's available slots.
All `lanes` entries can run concurrently when capacity permits; validation and
short control jobs are additional demand, and optional work has
repository-level limits. Standalone shards pay setup on every runner; this does
not reserve account-wide capacity. Optional purchase import starts only after
required CI succeeds and uses one repository background slot. Superseded PR
revisions cancel; sibling failures do not cancel independent checks. Rust
formatting, Clippy and tests collect results separately, and Playwright has no
failure-count cutoff; setup failures and existing timeouts still bound stuck
runs.

The ordinary changed-code PR goal is a five-minute p50, with p95 and
cold/native runs measured separately. Prefer fewer runners and runner-minutes
within that budget; a substantial resource saving can justify moving toward six
minutes. These are targets, not guarantees. Compare naturally occurring
successful runs on queue time, required-check p50/p95, cache misses,
cancellations, job-minutes and merge-to-deploy time, using the Actions job
timeline to separate waiting, setup, execution and Nx cache replay. Warm, cold
and environment changes are different populations; PR samples whose Mac jobs
all skipped say nothing about cold native queueing. Ship verified improvements
without a sampling quota, but measure before claiming a speedup.

Constraints that shape the current settings:

- Individual correctness cases target single-digit seconds. Report module
  collection and fixture startup separately from scenario execution; splitting
  a long scenario into cases does not establish less total work.
- Playwright's fully-parallel sharding takes contiguous equal-count slices, so
  one slow case stays on one shard. Keep cases short with page clocks or held
  responses rather than poll intervals.
- More browser workers raise navigation latency without a reliable
  critical-path gain; compare natural CI runs before changing worker counts.
- `context.route` asset caching disables Chromium's HTTP/code cache. Fewer
  chunks needs a renderer-boundary refactor: catch-all chunk grouping causes
  module initialization cycles.
- Cache dependency artifacts only when build savings exceed transfer costs.
- Vitest `vmThreads`/`vmForks` pools break the process and file-system tooling
  tests.

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

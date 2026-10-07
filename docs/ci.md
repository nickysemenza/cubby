# Continuous integration

GitHub Actions routes checks by affected files on pull requests and `main`
pushes. Required checks on the exact PR head are the merge gate. Merging to
`main` independently deploys every production Worker, including after a
documentation-only change; deployment never waits for post-merge CI.

## Local verification

The `Scope` job uses SHA-pinned [dorny/paths-filter v4](https://github.com/dorny/paths-filter)
with declarative rules in `.github/ci-paths.yaml`. PR file lists come from
GitHub's API; `main` pushes compare with the commit before the push. The action
owns pagination, rename detection, and Git fetching; Scope no longer checks
out full history or runs a repository-written diff parser. Unknown
non-documentation paths and manual verification select every lane. A failed
file lookup fails Scope instead of silently falling back to all checks; an
empty diff selects no affected lane. PR file lists inherit GitHub's 3,000-file
limit. A `cubby-ffi/` change selects both Apple and Rust checks (fmt, clippy,
and tests for `recipebridge` and `cubby-ffi`). Local affected-ness and
scoping remain Nx's job: every gate is a target on the project whose files it
covers (`apps/web/project.json` — `postgres`, `build-cf`, `e2e`,
`workers-tests`; `recipebridge/project.json` and `cubby-ffi/project.json` —
`rust`; `apps/apple/project.json` — `apple-check`; the repo-wide `generate`, `types`,
`lint`, `format`, `knip` gates stay on root `project.json`'s `cubby-checks`
project). Project relationships (`implicitDependencies` and `dependsOn`) decide
which projects and prerequisite targets are selected and ordered. Target
`inputs` and `dependentTasksOutputFiles` decide cache keys and whether a selected
target can reuse a prior result; they are separate concerns.

`pnpm verify:local` is an optional local diagnostic; commands and when to use
it live in the [validation policy](agents/validation.md) and
[quality guide](agents/validation-quality.md). Facts that shape it:

- `--parallel=1` is deliberate: every tier is already parallel inside (vitest
  workers, Playwright workers, cargo, xcodebuild), and running tiers side by
  side on one host reproduces the contention the sequential `test:all` removed
  — measured 2026-09-16, the web unit tier took 196s instead of 24s under
  `run-many`'s default parallelism and tripped a 5s test timeout.
- Most selected targets replay from Nx cache on a small change, so an unaffected
  native or PostgreSQL gate costs a cache lookup, not a rebuild. E2E is
  explicitly uncached and always runs its browser tests; its `build-cf`
  prerequisite may reuse a cache entry for the same source revision. Its key
  includes root configuration, bundled docs and agent skills, Git commit/branch, and explicit
  source overrides, matching the bundle metadata and provenance check.
- The textual order of the `run-many -t` list is not an execution-order
  contract; Nx dependencies provide the ordering (WASM before its consumers,
  web build before E2E). `verify:local:full` sets `NX_SKIP_NX_CACHE=true` so
  every target executes.

Commit hooks, push behavior, and the merge gate are defined in the
[validation policy](agents/validation.md); GitHub checks on the final PR head
remain the merge gate.

Node 24, pnpm 12.7.0, Rust/wasm-pack, Apple `container` on macOS (external PostgreSQL/IntegreSQL on Linux) and Playwright
browsers must be available; [test tiers](agents/validation-tests.md) cover database setup.
PostgreSQL remains the authoritative integration tier; Playwright defaults to
one worker on hosted runners and two on local macOS in `playwright.config.ts`,
the CI workflow passes `--workers=2` for each shard, and there are no retries. Both tiers reject an empty selection or an
unexpected skipped test without freezing the suite to a hand-maintained count;
a Vitest `-t` run accepts tests the pattern left out but still fails when the
pattern matches nothing or a matched test is skipped.
Browser verification always follows the current web build (the `e2e` target
`dependsOn: ["build-cf"]`).

These cache and dependency changes reduce duplicate work and stale generated
artifacts, but do not promise that two simultaneous full verifications are
resource-safe on the same machine. Keep heavy local runs coordinated when the
host is constrained.

A change under `apps/apple/` or `cubby-ffi/` selects the `apple` Nx target
(`scripts/apple-check.sh`, the former `ci-scope.ts` `runAppleCheck` body).
`apps/apple/scripts/prepare-project.sh` (extracted from the check script so
the hosted job can call it before `pnpm install` has ever run) does `node
scripts/ensure-apple-ffi.ts` (Nx-cached xcframework + UniFFI shim), `pnpm
generate` when `node_modules` exists (the generated Swift and the OpenAPI
inputs of the `CubbyAPI` build plugin; none is committed), and `xcodegen
generate --use-cache`. `apple-check.sh` then runs the `@State`/`@StateObject`
grep, `swift format lint`, and one of three modes: `full` (local default) additionally runs
`swift test --package-path apps/apple/CubbyKit` and a generic-simulator
`xcodebuild build`; `app` skips the package tests and only builds; `ci`
(hosted only) also skips the package tests and only builds, but passes
`-clonedSourcePackagesDirPath apps/apple/SourcePackages` so the build reuses
the SPM clone cache described below instead of resolving Sentry/GRDB/Nuke
from scratch. The script skips itself (with a message, not a failure) when
`xcode-select -p` fails, so a machine without Xcode still passes — `pnpm apple
check` runs `apple-check.sh full` directly. The `rust` target runs
fmt/clippy/test per crate (`recipebridge/project.json`,
`cubby-ffi/project.json`); `verify:local(:full)` runs both projects' `rust`
target regardless of what changed.

`cubby-ffi` and the WASM package share the `recipebridge` Rust core and Cargo
lockfile, but each target needs its own compiled artifacts. The EPUB cookbook
dependency belongs to the WASM-only `epub` module; Cargo's
target-specific dependency table keeps them out of native FFI and host test
builds. This preserves the required WASM dependencies without compiling unused EPUB
code for Apple targets.
The unused local Rust model-pricing export is removed; Cubby usage pricing
reads `models.dev` in TypeScript. Cookbook's upstream pricing table remains
transitive until the [pricing consolidation](todos.md#ai--search) is completed.

`apps/apple/project.yml`'s `Cubby-iOS` scheme also lists CubbyKit's own tests
as a local package test target (`package: CubbyKit/CubbyKitTests`), so
`xcodebuild test -scheme Cubby-iOS` on a simulator runs both `Cubby-iOS-Tests`
and CubbyKit's package tests together — useful locally, but hosted CI does not
use it (see below). `apps/apple/CubbyKit/Tests/CubbyKitTests/VisionHardware.swift`
defines a `.requiresVisionHardware` trait that skips Vision-dependent
contracts (`SubjectLift`, `FeaturePrintIndex`) when running on the Simulator,
for whichever caller — local or hosted — ends up running that scheme there.

Two hosted macOS jobs, `Apple host tests` and `Apple simulator build`, run in
parallel, gated on the
`scope` job's `apple` output. The scope job reads the PR file list or the files in a
`main` push. Native source, FFI, Rust bridge, shared API schemas and the shared
package (native constants, generator helpers, and Swift test vectors), the web
contracts and HTTP API layer, preview fixture inputs, the Worker media-origin
configuration (`wrangler.jsonc` and `wrangler-public-config.ts`), and CI policy
changes select Apple. These inputs affect generated Swift or its binding tests;
an Apple README or unrelated web page alone does not select Apple. The macOS jobs install no
Node dependencies: the Linux `Apple generated inputs` job runs `pnpm generate`
and uploads the generated Swift inputs as the `apple-generated` artifact
(`.github/actions/generate-apple-inputs`), which each restores directly with
`actions/download-artifact` before building,
using ordinary checkout timestamps. A skipped job still
satisfies its required status check. The host job runs the automatically generated
`CubbyKit-Package` scheme with `xcodebuild test` on the ARM macOS host — no
simulator. The aggregate package scheme includes all CubbyKit tests and the CLI
product; the library-only `CubbyKit` scheme has no test action. The command uses
`-onlyUsePackageVersionsFromResolvedFile` to keep the committed package pins.
Its `xcode-host-v1` cache stores `apps/apple/CubbyKit/.build`, including the
Xcode compilation cache and dependency checkouts under `.build/xcode` and the
SwiftPM warning-generator products. Xcode's `Build` and `Logs` directories are
excluded: tests rebuild products from cached compiler results rather than
restoring timestamp-sensitive objects and test bundles. Keys include the Xcode
toolchain, package pins, CubbyKit sources, and warning-check script. It then
runs `apps/apple/scripts/check-openapi-warnings.sh`, which fails on any
swift-openapi-generator warning (a schema the `CubbyAPI` build plugin would
silently drop). A successful warning check records its content key inside
the cached `.build` directory; unchanged document, config, generator pin,
toolchain, and check script reuse that pass without rebuilding or regenerating.
Changed inputs run the full check, and warnings or generator failures never
record a pass. The simulator job independently restores its simulator-only FFI
framework and runs `sh scripts/apple-check.sh ci`, a generic-simulator
`xcodebuild build` with no tests or simulator boot. The lightweight Linux
`Apple checks` job preserves the required status context and succeeds only when
both selected macOS jobs succeed; failures, cancellations, or unexpected skips
fail that gate. Aggregate checks use `!cancelled()` so whole-workflow
cancellation can stop them while ordinary failed dependencies still reach their
result checks. Release FFI warming waits for this gate on main.

Each SDK keeps its own compilation cache. Parallel jobs use two macOS
runner slots to avoid adding the host and simulator compile times after a
cache miss or source change. A generated-schema change still recompiles the
client for each SDK; neither cache reuse nor a five-minute ceiling is guaranteed.
The generated `CubbyAPI` target forwards `-gline-tables-only` directly to the
Swift frontend, so the driver's default `-g` does not restore full debug type
information. Handwritten Swift targets retain their normal debug information.

Both macOS build commands use `/usr/bin/time -l` to report elapsed time, CPU
time, and native resource counters in their job logs. These measurements help
compare cold and cached builds without adding a profiling script or job.

The Xcode project and host package-test command enable Apple's compilation cache
and its hit/miss remarks. Content-addressed results live in
`DerivedData/CompilationCache.noindex` for the simulator and
`CubbyKit/.build/xcode/CompilationCache.noindex` for the host, inside their
successful-build caches. This can replay compiler work when
ordinary build products need rebuilding but the compiler inputs are unchanged;
new source inputs still compile. Local `swift test` remains available and does
not use this Xcode cache. No extra runner or remote cache service is used.

A local ARM/Xcode 27 experiment on 2026-10-06 changed every native input's
mtime without changing its contents, then removed the Xcode build products.
The host's CAS-and-clones-only replay passed the same 661 tests in 37s
(386/386 compiler-cache hits), versus 130s cold. The simulator build replay
passed in 32s (227/227 hits), versus 161s cold. These demonstrate reuse without
the deleted timestamp helper or XCBuild inode override; they do not establish
hosted Xcode 26 job times or include GitHub cache transfer and runner queueing.
Manual native E2E installation (`apps/web/tooling/sim-e2e.ts`) uses the same
ordinary input timestamps. Removing a shared build helper requires checking
those manual callers as well as the required workflow.

The earlier simulator-test job ran `xcodebuild test` on a concrete simulator:
first boot cost about 6 minutes plus roughly 10 minutes of CPU starvation
(a 5s script took 2.6 minutes, and compilation doubled). Host tests and the
generic-simulator app build keep that simulator work excluded.
`.github/actions/setup-apple-tools` installs XcodeGen and restores
`apps/apple/SourcePackages`, the `xcodebuild`-resolved SPM clones for Sentry,
GRDB, Nuke and swift-openapi-generator (previously an uncached "Resolve Package
Graph" on every run), used by `Apple simulator build`. It is separate from the
target-specific FFI output cache (`.github/actions/setup-apple-ffi`) and the
host job's build cache described above. DerivedData keys explicitly exclude
the host `.build` directory; its compiled products are not simulator source
inputs. Host and simulator caches have separate Xcode toolchain and package
graph keys. Dependency declarations live in XcodeGen’s included
`apps/apple/packages.yml`; app versions and build settings stay in the product
key, so a version bump does not discard dependency precompiled modules. A
package declaration, local Swift package graph, or resolved-pin change still
invalidates those modules. The simulator build certificate includes both specs.

Compiled Apple caches are published only after successful work. GitHub cache
entries are immutable: saving an interrupted compile under the final content
key makes every exact hit repeat that unfinished work, and a successful build
cannot repair the entry. Simulator DerivedData `v6` excludes earlier entries
that could have been saved after cancellation or failure. Host `xcode-host-v1`
starts separately from the retired standalone SwiftPM `v2` cache. A new generation pays one cold build; unchanged successful restores
are the evidence for warm performance. Dependency clones remain advisory.
With the previous timestamp-normalizing backend, a controlled same-head [cold build and warm rerun](https://github.com/nickysemenza/cubby/actions/runs/37418543352)
on 2026-10-05 took 7:39 and 4:35 respectively in the Apple app job after the
successful exact-key DerivedData restore. Swift compilation log entries fell
from 1,380 to two. This verifies reuse for unchanged inputs; one controlled
rerun does not establish a PR median.
After the main cache was seeded, a [normal main Apple app job](https://github.com/nickysemenza/cubby/actions/runs/37423177521/job/112138086525)
on 2026-10-05 restored the same exact 419 MB DerivedData entry and passed in
3:47, with two Swift compilation log entries for generated asset symbols.
This confirms cross-run main-cache reuse, not a new required-check median.
A controlled [same-head SwiftPM cold build and warm rerun](https://github.com/nickysemenza/cubby/actions/runs/37423177521)
passed the same 646 tests in both attempts: the package job fell from 8:03 to
2:57 after restoring its exact main cache, and compilation fell from 357s to
72s. Cache restore and generator-warning checks still contribute to the warm
job. This controlled measurement does not establish a PR median.
Retire obsolete cache generations and merged PRs' private cache entries with
GitHub's cache controls after main is seeded; retain active PR and current main
entries. The repository keeps the default 10 GB cache limit, so no paid cache
capacity or custom cleanup scheduler is needed.

## Hosted suite

The `CI` workflow runs automatically for pull requests to `main` and pushes to
`main`. Superseded PR runs are canceled. Main runs finish rather than being
canceled by later merges, so selected native checks can publish reusable caches
and the sequential release-cache warming job can run. GitHub concurrency keeps
one main run active and at most one pending; a newer push replaces the pending
run. This does not add parallel main runs or jobs. The newest main CI result may
wait for the active run; deployment remains independent. `Scope` and
`Validation` retain stable required names. A documentation-only
change runs Oxfmt and offline relative-link validation through the pinned Lychee action.
Paths written as inline code are informational; link a repository file when its
existence should be checked. Formatting-only validation sets up Node and invokes the exact Oxfmt
version pinned in `package.json` with `npm exec`; it skips the workspace dependency
install and pnpm-store restore. Jobs that need generation or application code
still install their dependencies. Generated output is never
committed; every job that installs dependencies generates it (`postinstall`), and
`Validation`'s `generate` gate checks that it generates cleanly and that the OpenAPI
document lints. On PRs, Markdown changes select checks according to their runtime role:

| Changed Markdown                                                           | Selected work                                                                                 |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Ordinary guides and agent documentation                                    | Oxfmt and offline relative links                                                              |
| `docs/todos.md`                                                            | Documentation checks plus generation and OpenAPI lint, with filtered dependencies and no WASM |
| `docs/README.md`                                                           | Documentation and full web lanes: the fixed `/docs/` landing page is a runtime route input    |
| `.claude/skills/purchase-import/` and `.claude/skills/product-enrichment/` | Documentation, full web lanes, and the optional purchase-import browser lane                  |
| `.claude/skills/photo-inventory-import/`                                   | Documentation and full web lanes                                                              |

The three skill directories are bundled into Worker agent instructions. Every
web-affecting push to `main` also runs the optional purchase-import browser lane. Mixed
Markdown and code changes retain all checks selected by the code. Runner
startup, tool downloads, and any required generation still contribute to
measured documentation-only latency.
Native, auxiliary, Rust, web, and PostgreSQL/E2E lanes run only when their inputs
can affect them. A manual run selects all lanes. `Web checks` is the stable
required aggregate: it checks the web, PostgreSQL, and browser matrix results
whenever web validation is selected. Its shell-only status check uses the
standard `ubuntu-slim` container runner; it needs no checkout, dependencies,
services, or privileged operations. This keeps the same runner-slot count and
five-minute timeout. Queue and startup time remain part of measured gate latency.
`Auxiliary tests and builds` runs the selected auxiliary package tests and
USDA API build alongside the existing `unit`,
`mcp-contract`, `worker-safety`, and `ui` Vitest projects together in one job,
preserving each project's environment and isolation. One dependency setup and
MCP App build serve all four web projects; there is no fast-test job matrix.
When both tiers are selected, sharing their job removes one runner slot and
repeated setup. Web-only changes retain the filtered install; auxiliary changes
install the full workspace. Each tier keeps its own scope condition.
Node projects run first,
then UI uses Vitest's standard project group ordering, keeping each phase's
worker environment together. `Build Workers and runtime tests` builds the
web Cloudflare bundle (which hosts the purchase agent) and uploads it
with the MCP App assets and the WASM package as the `worker-build` artifact; the
workerd PostgreSQL project runs against that fresh bundle in the same job;
only the optional purchase browser lane downloads it after the job succeeds.
Desktop browser shards depend only on `Scope` and build the Worker during their
own setup, with the same source commit and branch provenance. This overlaps
setup with `Build Workers and runtime tests` without adding runner slots, at the cost of two
additional Worker builds. The browser lanes retain the discovery and no-skip guard;
desktop Chromium runs as two Playwright shards (two workers each). Phone-web and
WebKit browser coverage was removed from PR CI and the Playwright suite; native
checks remain separate. There is no coverage mode.
The disposable PostgreSQL container uses `fsync=off`, `synchronous_commit=off`,
and `full_page_writes=off`, matching the local test-service settings. These
[standard non-durable settings](https://www.postgresql.org/docs/17/non-durability.html)
remove disk durability work from synthetic test data; CI does not test database-server
crash recovery. SQL constraints, transactions, and the full reset still run.

Desktop CI passes Playwright's `--trace=off`: recording every test for
`retain-on-failure` adds work, and raw traces are excluded from hosted artifacts.
Local runs retain failure traces; CI preserves failure annotations, sanitized
case results, provenance, checksums, and structured Worker diagnostics.
For a local debugging replay, replace the manifest's `--trace=off` argument
with `--trace=retain-on-failure`.
Browser shards save sanitized case results, a run manifest, and SHA-256
checksums on success and failure for seven days. The manifest records the tested
commit, build fingerprint, and replay arguments; a dirty local run or unmatched
build is marked as not exactly replayable. The manually dispatched native
simulator E2E saves the same bundle format with its app build fingerprint and
runtime. Raw reports, traces, screenshots, and logs stay local because they may
contain household data or credentials.
`E2E tests (purchase import agent, optional)` runs the Playwright project of
that name (`purchase-import-run.spec.ts`: the purchase agent with a scripted
model and gateway, driven through the browser) on the same `worker-build`
artifact. It is informative only: it is not in `Web checks` or the ruleset,
and it runs on pushes to `main` and on PRs that touch the agent, purchase
import, the Run, Purchase and vendor order-mail UI, its harness, or the
bundled skills (`importE2e` in `.github/ci-paths.yaml`). It saves the
same run bundle as the desktop shards.
PostgreSQL integration tests use two runners. The `integration` Vitest
project runs all its files in one job with four fork workers, waits only on
`Scope`, and restores the WASM package itself. This removes one runner slot
and one repeated database/dependency setup compared with two shards. The
`integration-workerd` project (the files that start the built Worker, listed in
`workerdIntegrationTests` in `apps/web/vitest.config.ts`) runs after the build
in `Build Workers and runtime tests`. This removes its separate job, repeated
dependency setup and artifact download. The build result includes those tests;
ordinary integration files still start independently after `Scope`. A workerd consumer missing
from that list runs in the ordinary integration job and fails there, because
in CI the harness refuses to rebuild a missing or stale Worker. `Web checks` requires
both jobs to succeed, so the required-check name stays stable. Jobs that need
the databases (`test-postgres`, `build-worker`,
`test-e2e`) declare native GitHub Actions service containers. The PostgreSQL
integration job first runs `pnpm --dir apps/web db:check` against disposable
scratch databases, reusing its PostgreSQL and dependency setup. A migration
check failure fails that job and the required Web gate. YAML anchors reuse the
pgvector PostgreSQL and pinned IntegreSQL definitions. GitHub owns the network, container
startup, PostgreSQL health wait, logs, and cleanup. PostgreSQL also maps port
55432 for guarded named-database tests. `POSTGRES_INITDB_ARGS` sets the disposable
settings in the fresh PostgreSQL 17 configuration. IntegreSQL retries its
PostgreSQL connection during startup; its pinned distroless image has no
`/bin/sh` for Docker shell health checks. The optional purchase-import and
Tester Army Linux lanes use the same service definitions. Affected jobs wait on
`Scope`. The offline Markdown link check runs in `Validation` for Markdown
changes. The
`@claude` mention workflow (`claude.yml`) remains manual;
`claude-code-review.yml` reviews each non-Renovate, non-fork PR once,
on `opened`/`ready_for_review`/`reopened` (never on `synchronize`, so a push
does not trigger a re-review), using Sonnet 5. Preview deploys were removed;
production is the only deployed environment.

## Apple TestFlight release

Pushing a `vMAJOR.MINOR.PATCH` tag at a `main` commit is the release:
`.github/workflows/apple-testflight.yaml` runs on `push: tags: ["v*"]`, needs
only `contents: read`, and always uploads — there is no dry-run mode, no
`workflow_dispatch`, and no `tag` job (the tag already exists by definition).
A `coordinates` job on `ubuntu-latest` fails fast before any macOS runner
starts: it derives `version` from the tag name and rejects anything that is
not exactly `MAJOR.MINOR.PATCH` (so a `v1.0.6-rc1` tag matches the trigger
but fails in seconds), computes `build` as `<commit count>.<run_attempt>`,
and requires the tagged commit to be an ancestor of `origin/main`. A failed
release leaves its tag in place: `gh run rerun --failed` reuses the tag and
produces build `<count>.2`, and a release that needs a code fix simply moves
on to the next version — a dead tag is accepted rather than guarded against.

An `archive` matrix job then runs the iOS and macOS archives in parallel
(`macos-26`, `fail-fast: false`), each restoring only its own
`setup-apple-ffi` target (`device`/`mac`, `profile: dist`) instead of `all`,
roughly halving the Rust work any one archive job pays for on a cold cache.
Each leg tars its signed `.xcarchive` (including dSYMs) before uploading it as
a short-retention artifact — `actions/upload-artifact` zips its input and
does not preserve the executable bit or symlinks, which would leave
`Cubby.app`'s main binary non-executable and its embedded framework symlinks
flattened after download. A single `upload` job then downloads both
archives, untars them back to the exact paths `testflight.sh` expects,
re-imports the signing identities and profiles (`xcodebuild -exportArchive`
re-signs, so it needs them even though `archive` already verified them), and
runs `apps/apple/scripts/testflight.sh export ios` and `export macos`.
Because `upload` `needs` both matrix legs, neither platform exports — let
alone uploads — unless both archived successfully, preserving the
neither-platform-uploads-alone invariant. `testflight.sh` has two
subcommands, `archive <ios|macos>` and `export <ios|macos>`; the macOS
`archive` verification asserts the archived Info.plist has a non-empty
`LSApplicationCategoryType` (the v1.0.3 failure), and the Mac Installer
Distribution identity check (the v1.0.2 failure) runs in both the macOS
`archive` leg and the `upload` job, each behind its own signing import.

A `warm-apple-ffi` job in `ci.yaml` runs after successful required Apple checks
on `main` pushes selected for Apple. One macOS runner restores/builds the
`mac`/`dist` then `device`/`dist` `setup-apple-ffi` caches sequentially, keeping
their compiled products and output keys separate. The disposable macOS
XCFramework is removed before the device restore to prevent cache overlays.
If the macOS phase fails, the device phase is skipped; a later release can
still build either missing cache. These background builds no longer run
alongside the required native gate. A release normally restores the warmed
outputs rather than compiling Rust from scratch. Warming is not a required
check.

To validate a change to the release workflow without uploading anything,
push a deliberately invalid tag such as `v0.0.0-smoke`: it matches `v*`,
runs only the ubuntu `coordinates` job, and fails the version regex in
seconds, which proves the trigger, permissions, and checkout path. Delete it
afterwards (`git push --delete origin v0.0.0-smoke`). Never push a throwaway
numeric tag — it would upload a real build to App Store Connect.

## Deployment

`.github/workflows/deploy.yaml` runs on `main` pushes and deploys all four
production Workers every time. The purchase-agent deploy waits for the web
Worker, while the auxiliary Workers run
independently. Each Worker serializes production deployments and checks that
the commit is still current main before building and again before deploying.
Production never depends on a test job.
This trusts required PR checks before merging. Public-repository standard
GitHub-hosted runners are free; no self-hosted runner or Cloudflare Builds is
required.

All three jobs call the shared `.github/actions/deploy-worker` composite
(`check-current-main` → `setup-node-with-deps` → an optional build command →
`check-current-main` again → the deploy command), differing only in package,
workspace filter, whether WASM is needed, and the build/deploy commands;
`concurrency`, `environment`, and `timeout-minutes` stay on each job because
a composite action cannot own them. Every deploy is a plain shell command
with `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` in the environment: the
auxiliary Workers and purchase-agent run their package's own `deploy`
script, and web runs `wrangler deploy --config dist/server/wrangler.json`
directly rather than its `deploy:cf` script (`build:cf && wrangler deploy`),
which would rerun `build:cf` a second time after the composite's own build
step already ran it. The second `check-current-main` is what stops a manual
re-run of an old Deploy run from rolling production back to a stale commit.

## Branch protection and measurement

The `main` ruleset requires `Scope`, `Validation`, `Web checks`, auxiliary,
Rust, and Apple checks. Non-matrix jobs that are unaffected are skipped; the
web aggregate verifies every selected matrix lane. Keep `strict` disabled so
a green non-conflicting branch need not rebase, allow administrator bypasses,
and do not require human review.

Record ten exact-head public PR runs before changing topology: queue time,
required-check p50/p95, per-lane duration, cache behavior, cancellations, and
merge-to-deploy duration. The target is a 4–7 minute warm critical path and no
more than 10 minutes cold. Optimize only a measured bottleneck; prior evidence
already rejects node_modules caching and extra E2E sharding. Track queue and
cold native builds separately; the target is not a measured runtime guarantee.

### Measured decisions

Keep the full experiment tables in Git history; this page records the decisions
that still shape the current checks. When changing CI topology, collect at least
five naturally occurring successful exact-head PR runs before claiming a new
median, and compare queue time, required-check p50/p95, cache misses,
cancellations, job-minutes, and merge-to-deploy time. Do not infer a speedup
from a single warm run or a different host load.

Before the PostgreSQL/runtime split, ten successful PR runs sampled on
2026-10-05 had a slowest desktop E2E job of 7:35–8:44, with job-ready-to-start
waits no longer than 57 seconds. Representative
[web](https://github.com/nickysemenza/cubby/actions/runs/37407377916) and
[cross-client](https://github.com/nickysemenza/cubby/actions/runs/37406566591)
runs show that browser execution and native compilation remain the full-PR
bottlenecks. The split removes an unnecessary prerequisite for ordinary
database contracts; it does not establish a five-minute full suite.

- Desktop Chromium uses two shards. More workers per runner and three shards
  did not improve the required-check critical path enough to justify their
  setup and contention costs. Keep the two browser shards when several PRs run
  concurrently. Ordinary PostgreSQL files share one four-worker job; workerd
  integration runs in the Worker build job against its fresh bundle.
  A three-worker re-benchmark on the larger suite passed all 160 cases, but a
  same-head replay of its slower 80-case shard reduced Playwright execution
  only from 391 to 375 seconds while cumulative case time rose from 665 to
  911 seconds and navigation time from 270 to 377 seconds. Keep two workers
  per runner: the repeated latency increase did not justify the small,
  variable critical-path benefit. The
  [bounded trial](https://github.com/nickysemenza/cubby/actions/runs/37499250416)
  and [two-worker baseline](https://github.com/nickysemenza/cubby/actions/runs/37497540250)
  do not establish a new median or isolate runner variability.
  Phone and WebKit browser projects were removed
  from PR CI; device-dependent phone behavior still needs device acceptance.
- The fast projects share one job to reduce runner demand. Ten completed PR
  runs sampled on 2026-10-06 (six successful, four failed) had Node jobs of
  1:47–2:06 and UI jobs of 1:21–1:43, while the slowest desktop shard took
  7:51–8:58. Representative
  [successful](https://github.com/nickysemenza/cubby/actions/runs/37426186409)
  and [failed](https://github.com/nickysemenza/cubby/actions/runs/37426021174)
  runs support testing that consolidation outside the browser critical path;
  they do not establish the combined job's hosted runtime or a new PR median.
- Test page loads spend much of their time waiting for hydration and queued
  JavaScript chunks under the harness's HTTP/1.1 connection limit. A measured
  HTTPS/HTTP/2 proxy added runner time without a useful end-to-end gain.
  Preloading the recipebridge WASM also did not improve hydration.
- Caching `node_modules` was slower than installing from the warm pnpm store.
  Saving the pnpm store from Playwright containers likewise cost more than the
  filtered install. Retain exact-key caches for generated artifacts and Apple
  dependencies where the measured build work exceeds restore cost.
- Local full verification runs Nx targets sequentially because the individual
  test/build tiers are parallel internally. The parallel `run-many` trial took
  10:54 and failed under contention; the sequential trial took 6:49 and passed
  on the same shared host. These are observations, not runtime guarantees.
- Keep pure grouping and projection tests in the fast tier, transaction and
  SQL behavior in PostgreSQL, and browser-only contracts in Playwright.
  Previously consolidated test files and changed worker counts are not reasons
  to move a behavior to a more expensive tier.

## Operational checks

Before changing CI, run:

```sh
actionlint -no-color .github/workflows/*.yaml
pnpm run check
pnpm exec nx show projects --affected --base=origin/main
```

After a material workflow change, compare at least ten representative runs for
PR p50/p95 wall time, merge-to-deploy time, total job-minutes, cancellations,
and cache behavior.

# Continuous integration

GitHub Actions runs the complete verification matrix on every pull request to
`main` and every `main` push. Required checks on the exact PR head are the merge
gate. Merging to `main` independently starts deployment of affected production
Workers; deployment never waits for post-merge CI.

## Local verification

`scripts/ci-scope.ts`'s hand-rolled path classifier is gone. Affected-ness and
scoping are now Nx's job: every gate is a target on the project whose files it
covers (`apps/web/project.json` — `postgres`, `build-cf`, `e2e`,
`workers-tests`; `recipebridge/project.json` and `cubby-ffi/project.json` —
`rust`; `apps/apple/project.json` — `apple-check`; the repo-wide `generate`, `types`,
`lint`, `format`, `knip` gates stay on root `project.json`'s `cubby-checks`
project). Project relationships (`implicitDependencies` and `dependsOn`) decide
which projects and prerequisite targets are selected and ordered. Target
`inputs` and `dependentTasksOutputFiles` decide cache keys and whether a selected
target can reuse a prior result; they are separate concerns.

`pnpm verify:local` is an optional local diagnostic:
(`nx run-many -t generate,types,lint,format,knip,test,postgres,build-cf,e2e,rust,apple-check --parallel=1`).
`--parallel=1` is deliberate: every tier is already parallel inside (vitest
workers, Playwright workers, cargo, xcodebuild), and running tiers side by
side on one host reproduces the contention the sequential `test:all` removed
— measured 2026-09-16, the web unit tier took 196s instead of 24s under
`run-many`'s default parallelism and tripped a 5s test timeout.
It first rejects an uncommitted or untracked working tree and checks it again
after the run; any generated churn must be resolved before handoff. It then runs
every target across every project —
most selected targets replay from cache on a small change, so an unaffected
native or PostgreSQL gate costs a cache lookup, not a rebuild. E2E is explicitly
uncached and always runs its browser tests; its `build-cf` prerequisite may
reuse a cache entry, but the browser run itself never replays. The textual order
of the `run-many -t` list is not an execution-order contract; Nx dependencies
provide the ordering guarantees (including WASM before its consumers and the
web build before E2E). It deploys nothing. `pnpm verify:local:full` sets
`NX_SKIP_NX_CACHE=true` first, forcing every target to actually execute
regardless of cache state — use it for high-risk changes or before a release.
Both print static actionable diagnostics and step timings.

**Git operations.** Pre-commit runs `pnpm check:staged`, which uses lint-staged
with the existing Oxlint and Oxfmt rules on staged files only. Checks are
read-only, preserve partial staging, and report issues for explicit correction.
There is no pre-push hook or push-time verifier. A push does not require a clean
working tree or refreshed base ref. The [validation policy](agents/validation.md)
controls local feedback and handoff; GitHub checks on the final PR head remain
the merge gate.

Node 24, pnpm 12.4.1, Rust/wasm-pack, Apple `container` on macOS (external PostgreSQL/IntegreSQL on Linux) and Playwright
browsers must be available. Follow [validation guidance](agents/validation.md) for database setup.
PostgreSQL remains the authoritative integration tier; Playwright retains a
single worker and no retries. Both tiers reject an empty selection or an
unexpected skipped test without freezing the suite to a hand-maintained count.
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
scripts/ensure-apple-ffi.ts` (Nx-cached xcframework + UniFFI shim; a stale
committed `cubby_ffi.swift` fails as a dirty tree) and `xcodegen
generate --use-cache`. `apple-check.sh` then runs the `@State`/`@StateObject`
grep, `swift format lint`, `apps/apple/scripts/generate-openapi.sh --check`,
and one of three modes: `full` (local default) additionally runs
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

`apps/apple/project.yml`'s `Cubby-iOS` scheme also lists CubbyKit's own tests
as a local package test target (`package: CubbyKit/CubbyKitTests`), so
`xcodebuild test -scheme Cubby-iOS` on a simulator runs both `Cubby-iOS-Tests`
and CubbyKit's package tests together — useful locally, but hosted CI does not
use it (see below). `apps/apple/CubbyKit/Tests/CubbyKitTests/VisionHardware.swift`
defines a `.requiresVisionHardware` trait that skips Vision-dependent
contracts (`SubjectLift`, `FeaturePrintIndex`) when running on the Simulator,
for whichever caller — local or hosted — ends up running that scheme there.

Two hosted macOS jobs cover the Apple surface, both gated on the `scope`
job's `apple` output. On a pull request `dorny/paths-filter` computes it from
the PR's changed files: anything under `apps/apple/`, `cubby-ffi/`, or
`recipebridge/`, plus `rust-toolchain.toml`, `scripts/ensure-apple-ffi.ts`,
`scripts/rust-fingerprint.ts`, `scripts/apple-check.sh`,
`apps/web/src/lib/generated/http-openapi.gen.json`, `ci.yaml` itself, and the
two composites the Apple jobs use (`setup-apple-ffi`, `setup-apple-tools`).
On a `push` or `workflow_dispatch` there is no PR diff to check and it is
always `true`. A skipped job
still satisfies its required status check (GitHub treats a skipped required
job as passing). `Apple package tests` runs `swift test --package-path
apps/apple/CubbyKit --force-resolved-versions` on the macOS host — no
simulator — restoring/saving an exact-key cache of
`apps/apple/CubbyKit/.build/{checkouts,repositories}` keyed on
`Package.resolved` (SPM fetch+resolve was 53s of that job otherwise). `Apple
checks` runs `sh scripts/apple-check.sh ci`, a generic-simulator
`xcodebuild build` with no tests. Both were previously one merged job that
also ran `xcodebuild test` on a concrete simulator; that was reverted after
measuring a hosted runner's first simulator boot at about 6 minutes plus
roughly 10 minutes of CPU starvation on top of it (a 5s script took 2.6
minutes, the compile itself doubled) — the merged job took 13 minutes even
with every cache warm, so two separate jobs are faster than one.
`.github/actions/setup-apple-tools` installs XcodeGen and restores two more
caches, both used only by `Apple checks`: the `swift-openapi-generator` 1.13.1
binary it builds from source (keyed on the generator package's inputs and the
Swift toolchain version, so a warm cache skips rebuilding it from scratch —
previously about 140s every run), and `apps/apple/SourcePackages`, the
`xcodebuild`-resolved SPM clones for Sentry, GRDB, and Nuke (previously an
uncached "Resolve Package Graph" on every run). Both are separate from the
target-specific FFI output cache (`.github/actions/setup-apple-ffi`) and the
package-test job's SPM checkout cache described above.

## Hosted suite

The `CI` workflow runs automatically for pull requests to `main` and pushes to
`main`. It runs repository validation and dependency deduplication, auxiliary
tests and Worker builds, Rust checks, web node/UI tests, PostgreSQL integration
tests, Chromium and WebKit E2E, and (when the Apple path filter above matches)
`Apple package tests` and `Apple checks` — see above for why those stayed two
separate jobs. The browser lanes test the exact bundle produced by the node
test lane and retain the discovery and no-skip guard; chromium runs as two
Playwright shards (`--shard=1/2`/`--shard=2/2`, one worker each — two workers
on a single runner flaked, see `apps/web/tooling/e2e-workers.ts`) and webkit
runs unsharded. There is no coverage mode. `test-postgres` and `test-e2e` each
declare their own `postgres`/`integresql` `services:` block — GitHub Actions
YAML has no anchors and no reusable construct that fits here, so the
duplication is accepted rather than worked around. Every test job starts
immediately; only the two Apple jobs wait on `scope`. The separate Markdown
link workflow and the `@claude` mention workflow (`claude.yml`) remain
manual; `claude-code-review.yml` reviews each non-Renovate, non-fork PR once,
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

A `warm-apple-ffi` job in `ci.yaml` runs on every `main` push (not gated on
`scope`, since there is no PR path filter to apply to a push) and
restores/builds the `device`/`dist` and `mac`/`dist` `setup-apple-ffi`
caches, so a release normally hits a warm cache instead of the cold
~7-minute Rust build those two cache keys previously only ever saw during a
release itself. It is not a required check.

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

After the first passing PR exposes the check names, protect `main` by requiring
a pull request and every CI lane. Keep `strict` disabled so a green
non-conflicting branch need not rebase, allow administrator bypasses, and do not
require human review.

Record ten exact-head public PR runs before changing topology: queue time,
required-check p50/p95, per-lane duration, cache behavior, cancellations, and
merge-to-deploy duration. The target is a 4–7 minute warm critical path and no
more than 10 minutes cold. Optimize only a measured bottleneck; prior evidence
already rejects node_modules caching and extra E2E sharding.

### Public exact-head run ledger

Record wall time from GitHub job metadata, not summed step duration. Cache
state comes from each job summary, `cancelled` is the workflow conclusion, and
deployment time is measured from the merged commit's `main` push to the
matching Cloudflare deployment completion. Keep five successful exact-head
samples for an experiment before retaining it: its targeted step's p50 must
improve by at least 10%, with no regression in the required-check critical
path. Append the remaining samples here rather than inventing a timing value
from a partial or stale run.

| PR / exact head | Queue | Required lanes (wall) | Cache state | Cancelled | Merge to Cloudflare |
| --- | ---: | --- | --- | --- | ---: |
| [#1102](https://github.com/nickysemenza/cubby/pull/1102) / `ac4aad71` | not captured | validation 168s; auxiliary 54s; Rust 21s; web node 97s; web UI 67s; PostgreSQL 121s; Chromium 358s; WebKit 183s; Apple checks 647s; Apple package 308s | macOS pnpm-store hit (732 MiB; setup 72s); Rust FFI target hits | no | 82s |

### 2026-09-21 Apple setup caches, path filter, chromium shards

Exact-head runs of [#1163](https://github.com/nickysemenza/cubby/pull/1163)
(every run touched `.github/`, so both Apple jobs ran). Baseline is run
35644114202 on `main` before the branch: PR wall **600s**; Apple checks 544s
(140s generator build, 93s SPM clone, 53s unneeded `pnpm install`); Apple
package tests 301s after a 154s runner queue; chromium 433s on one worker.

| Run | Apple caches | PR wall | Apple checks | Apple package | Chromium | Note |
| --- | --- | ---: | ---: | ---: | --- | --- |
| 35652760985 | cold | — | 1089s (failed) | merged into Apple checks | 345s (2 workers) | simulator tests: 4 Vision suites cannot run on the simulator; one real bug in `PhotoRecordSearch` |
| 35655298230 | cold (saved on exit) | 1139s | 1082s | merged | 416s (2 workers) | simulator pre-booted at job start starved the FFI restore (41s → 281s) |
| 35657369044 | warm | 918s | 899s | merged | 330s (2 workers, **1 flake**) | boot moved after restores: still ~10 min of CPU starvation |
| 35659623444 | warm | **325s** | **296s** | 309s (SPM checkouts cold, saved) | **216s / 284s** (2 shards, 1 worker each) | two macOS jobs restored; retained |

**Decisions.** Retained: generator-binary and SPM-clone caches (generator
step 140s → under 5s warm; Resolve Package Graph 93s → 28s), dropping the
Apple job's `pnpm install`, the PR path filter, two chromium shards at one
worker each. Rejected: CubbyKit tests on the iOS Simulator inside the build
job (a hosted runner's first boot is ~6 min and starves the 3-core machine
for ~10 more, so the merged job was 13–18 min) and two Playwright workers on
one runner (one flake in three runs). One warm sample so far; append further
exact-head rows before changing this topology again.

### 2026-09-20 serial experiment record

The rows below are GitHub job wall times for five successful reruns of each
unchanged public PR head. `queue` is the `Apple checks` job's
`created_at`-to-`started_at` wait; the individual lane figures exclude that
wait. `S`, `V`, `A`, `R`, `N`, `U`, `P`, `C`, `W`, `I`, and `K` mean Scope,
Validation, Auxiliary, Rust, web Node, web UI, PostgreSQL, Chromium, WebKit,
Apple checks, and Apple package tests. All runs completed without cancellation.

| Exact head / attempt | Queue | Required lane walls (seconds) | Cache policy | Cancelled | Merge to Cloudflare |
| --- | ---: | --- | --- | --- | ---: |
| [#1105](https://github.com/nickysemenza/cubby/pull/1105) `46a920e4` / 1 | 238s | S 3; V 191; A 52; R 36; N 84; U 48; P 123; C 296; W 199; I 514; K 266 | macOS pnpm store hit | no | 79s |
| `46a920e4` / 2 | 9s | S 3; V 188; A 54; R 36; N 75; U 59; P 97; C 328; W 197; I 560; K 261 | macOS pnpm store hit | no | 79s |
| `46a920e4` / 3 | 7s | S 2; V 143; A 48; R 30; N 70; U 73; P 118; C 346; W 196; I 471; K 255 | macOS pnpm store hit | no | 79s |
| `46a920e4` / 4 | 7s | S 4; V 199; A 48; R 37; N 88; U 59; P 110; C 329; W 185; I 630; K 271 | macOS pnpm store hit | no | 79s |
| `46a920e4` / 5 | 6s | S 3; V 191; A 53; R 32; N 97; U 59; P 121; C 345; W 197; I 606; K 204 | macOS pnpm store hit | no | 79s |
| [#1107](https://github.com/nickysemenza/cubby/pull/1107) `a5a2586a` / 1 | 11s | S 5; V 198; A 47; R 22; N 99; U 67; P 155; C 320; W 213; I 551; K 324 | iOS pnpm store disabled; Linux store hit | no | 98s |
| `a5a2586a` / 2 | 15s | S 4; V 211; A 43; R 24; N 96; U 71; P 109; C 344; W 185; I 503; K 236 | iOS pnpm store disabled; Linux store hit | no | 98s |
| `a5a2586a` / 3 | 6s | S 3; V 196; A 49; R 34; N 91; U 62; P 137; C 290; W 183; I 428; K 316 | iOS pnpm store disabled; Linux store hit | no | 98s |
| `a5a2586a` / 4 | 227s | S 3; V 196; A 47; R 24; N 80; U 67; P 117; C 339; W 173; I 540; K 230 | iOS pnpm store disabled; Linux store hit | no | 98s |
| `a5a2586a` / 5 | 7s | S 4; V 208; A 48; R 23; N 89; U 59; P 118; C 332; W 197; I 443; K 297 | iOS pnpm store disabled; Linux store hit | no | 98s |

**Decisions.** Hosted Swift batch compilation's iOS app-check step was
425/433/370/526/493s (p50 **433s**, 19.5% below the 538s pre-experiment
baseline); its Apple-job p50 was 560s, 13.4% below the 647s baseline. It was
retained in [#1105](https://github.com/nickysemenza/cubby/pull/1105). With
that configuration retained, skipping the 732 MiB macOS pnpm-store restore in
only the iOS job reduced dependency setup from a 68s p50 to **41s** (39.7%)
and Apple-job p50 from 560s to **503s** (10.2%), without changing the critical
path topology. It was retained in
[#1107](https://github.com/nickysemenza/cubby/pull/1107).

The target-specific FFI output cache then ran five green exact-head samples on
`55a03282`: simulator FFI setup was 8/45/7/8/12s (p50 **8s** versus about 55s
of FFI preparation before this cache), and iOS app checks were
271/421/299/389/376s (p50 **376s**). The macOS package target had one normal
207s cold build, then warm output-cache restores; simulator and macOS keys are
disjoint. Apple-job walls were 340/531/368/466/484s (p50 **466s**, below the
503s retained-store control), so there was no required critical-path
regression. The cache was retained in
[#1108](https://github.com/nickysemenza/cubby/pull/1108); its merged commit
reached the completed Cloudflare deployment in **79s**. No runner-size,
node_modules-cache, E2E-shard, artifact-handoff, or deployment-serialization
change was made.

Cloudflare Workers Builds was piloted and rejected: native PostgreSQL/pgvector/
IntegreSQL and both browser engines worked, but no run reached a complete
hosted pass with a cold-plus-two-warm timing result, so the pilot was
disconnected and CI stayed on GitHub Actions plus local verification.

The workflow policy takes effect after merging this branch. On September 7,
2026, the complete warm `pnpm verify:local:full` passed in **124.47 seconds**
on the local ARM Mac. The preceding pre-push run took 289.37 seconds including
about 135 seconds of Rust compilation. Those predate the `cubby-ffi` manifest
and the `apple` check (2026-09-11); re-measure after the split. These are
individual observations, not a guaranteed runtime; see
[local measurements](local-check-performance.md).

## Measurements and rejected optimizations

Baseline before the 2026-08 refactor:

- Green web PR: roughly 3.5 minutes wall time.
- Merge to production: roughly 4.2 minutes because all PR work ran again.
- Unit tests with coverage: roughly 131 seconds.
- Integration shards with coverage: roughly 115–129 seconds each.
- E2E shards: about 41 seconds of container setup plus 97–101 seconds of tests.

Keep these measured negative results in mind:

- Caching `node_modules` was slower than recreating its links from the warm pnpm
  store: about 35 seconds to restore versus about 21 seconds to install.
- Saving the pnpm store from Playwright containers spent 41–49 seconds
  compressing a cache while the filtered install normally took about 20 seconds.
- Restore-only of that 318 MB cache also measured 20–25 seconds and did not buy
  back the common install cost.
- Three E2E shards did not beat two because fixed container/setup cost and suite
  variance erased the theoretical gain. Revisit only with duration-balanced
  shard data.
- A dedicated gate job once added up to 107 seconds of runner queueing merely to
  evaluate dependency results. Deployment jobs now evaluate their own gates.
- Passing the WASM package through a producer dependency cost another runner
  acquisition (about 23 seconds median and 90 seconds p95). Compiler-capable
  consumers use the shared exact-key cache instead.

The rewritten local-suite budgets are 15 seconds for fast tests, 40 seconds for
PostgreSQL, 35 seconds for Playwright, and 60 seconds end to end (55-second
median target). Re-benchmark five warm `pnpm test:all` runs after changing test
selection, worker counts, database provisioning, or browser harness startup.

### Integration families to vitest-native (2026-09-15)

The 8 `src/server/integration-families/*.integration.test.ts` import-index
files (each importing many real `*.integration.test.ts` contract modules to
fake a "family" Vitest could target as one file) are gone. The `integration`
Vitest project now includes `src/**/*.integration.test.ts` directly — 77 real
files (one, `garden.integration.test.ts`, moved from
`integration-families/` to `src/server/repo/`, a real 1,070-line contract, not
an index) — with `pool: "forks"`, `isolate: false`, so a worker's fork shares
one module graph across its share of those files instead of re-isolating for
each. `test:file:postgres <path>` runs that exact file directly
(`vitest run --project integration <path>`, no resolver or family indirection).

Measured on the same 8-core, 24 GiB Mac, `VITEST_MAX_WORKERS=6`, comparing the
old family structure against the new one on the same commit (only
`vitest.config.ts`/the file layout differed). `uptime` load is the 1-minute
average at the start of each run — the host was shared with other concurrent
work, so absolute numbers are noisy; the comparison is same-host, same-load-ish,
interleaved:

| Structure | Wall times (s) | Median | Vitest-reported duration (s) | Load (1-min) at each run |
|---|---|---|---|---|
| 8 family files (before) | 28, 29, 31 | 29s | 25.25, 25.36, 26.77 | 4.6, 6.0, 6.7 |
| 77 real files, `isolate: false` (after) | 34, 27, 35, 20, 20 | 27s | 27.23, 22.66, 30.86, 16.25, 16.40 | 28.6, 19.6, 14.1, 14.1, 11.2 |

The after-column ran under markedly *higher* average load (other work
contending for the same 8 cores) and still matched or beat the before-column's
median on both wall time and Vitest's own duration; the two fastest after-runs
(16.3s duration, 20s wall, load 11–14) landed well below every before-run. Both
structures pass the same 420/425 tests with the same 5 pre-existing failures
in `product-orchestration.service.integration.test.ts` and
`recipe-costing.cascade.integration.test.ts` (a stale fixture missing fields
added elsewhere, and a `warn` call-count assertion) — unrelated to this
restructure and reproduced identically before and after it, so they are not a
regression here. Bring-up cost (a single 5-test file via `test:file:postgres`,
wall time minus Vitest's own reported duration): ~3.5s before, ~3.5s after —
unchanged, as expected (bring-up is the container pair, not the test layout).
Ten slowest files: before, the worst "file" was really a family lump (18.9s
`integrity`, 18.3s `financial`, 15.2s `inventory`, 14.3s `recipe`); after, the
worst real file is 5.0s (`repo/problems.integration.test.ts`), then 3.6s
(`repo/ingredient.integration.test.ts`) — the balanced 77-file split removes
the lumpy tail a handful of oversized family files used to create. Three
shuffle seeds (default, `CUBBY_TEST_SHUFFLE_SEED=1`, `=2`) reproduced the exact
same 5 failures with no additional flakes, so `isolate: false`'s per-worker
module singletons (`db.ts`'s `moduleRuntime` pool, `cf-env.ts`, `clients/ai.ts`,
`ai/models.ts`, `semantic/embeddings.ts`, `clients/notion.ts`'s LRU caches)
did not surface a cross-file dependency in this run. **Decision: kept
vitest-native** — median wall and duration were ≤ the family baseline despite
higher load during the after-runs.

All tests that directly import the complete MCP server now live in the
`mcp-contract` project with `isolate: false`; test-owned server instances are
still constructed per contract. `worker-validation.unit.test.ts`, which
temporarily replaces globals, is the sole member of the isolated
`worker-safety` project. Both the package fast-test script and hosted Node lane
select `worker-safety`, while the obsolete hosted `unit-pure` selector is gone.
Every group-0 project shares the same worker cap because Vitest rejects mixed
`maxWorkers` values within one `groupOrder`.

Four versus five workers was measured with the fingerprinted MCP bundle already
built and actual, uncached Vitest execution. Five interleaved solo runs per
setting produced medians of **54.17s** (4) and **65.24s** (5), with maxima of
54.85s and 70.32s. Five simultaneous cross-worktree pairs per setting produced
medians of **103.33s** (4) and **99.10s** (5), with maxima of **124.83s** and
**147.24s**. Starting load averages ranged from 12.75 to 173.83; these are busy
host observations, not an idle-machine guarantee. All 30 suite executions
passed with no discovery, teardown, assertion, or shuffle-order failure. Four
workers is retained because its solo median was not slower and its paired
maximum improved; the slightly slower paired median is recorded rather than
hidden. This sample does not establish a formal flake probability.

### Apple container worker measurements (2026-09-15)

On the 8-core, 24 GiB Mac running macOS 27, `container` 1.4.1 and Node
26.8.2, each PostgreSQL run created a fresh PostgreSQL/IntegreSQL pair from
cached images and passed all 407 contracts. Wall times include startup and
cleanup; three samples per worker count were interleaved:

| PostgreSQL workers | Wall times (seconds) | Median |
|---|---|---|
| 2 | 51.30, 78.96, 62.20 | 62.20s |
| 4 | 40.37, 67.18, 41.98 | 41.98s |
| 6 | 31.62, 36.90, 44.91 | 36.90s |

The local default is **6 workers**; `VITEST_MAX_WORKERS` still overrides it.
Sampled memory availability stayed at or above 44%; swap usage at run
boundaries decreased across the comparison. These are measurements on a busy development machine,
not a runtime-independent speed guarantee. Each completed run left zero
containers and zero volumes; downloaded images remained cached.

Seven warm `NX_SKIP_NX_CACHE=true pnpm test:all` samples on 2026-09-15 (median
**250.21s**; 3 of 7 hit a hydration timeout — sample 3: calendar; sample 6:
placement navigation and mobile; sample 7: relationship page) and the
worker-scoped browser harness's 141.59s three-worker sample are the
historical baseline this section replaced;
both predate the `test:all` sequencing fix below. Keep them as reference only —
the test count, sequencing, and worker cap have all since changed, so their
absolute wall times are not comparable to the table below.

### E2E flake root cause and `test:all` sequencing (2026-09-16)

`test:all` ran `concurrently "pnpm test:postgres" "pnpm test:e2e"`: 6 vitest
forks plus 3 Playwright workers (each its own Node process running workerd and
a browser), a 4-vCPU PostgreSQL VM, and a 1-vCPU IntegreSQL VM, all on one
8-core host at once. `waitForAppHydration` (`tests/e2e/e2e-helpers.ts`) waits
for the authenticated shell's `data-hydrated="true"` marker — bundle fetch,
parse, and execute on a main thread starved by that oversubscription — while
`gotoAuthenticatedPage` navigates with `domcontentloaded`, so the same 15s
budget also covers SSR's `get-session` lookup racing the concurrent
PostgreSQL tier's `pg_terminate_backend` + truncate-and-reseed cycle per unit
test. `trace: "on-first-retry"` paired with `retries: 0` meant a failure never
recorded a trace, and the helper's one message ("Sign In is visible") covered
both an unhydrated shell and SSR genuinely rendering the signed-out shell,
so a flake gave no way to tell which had happened without re-running under a
debugger.

Fix, landed here: (1) `test:all` → `pnpm test && node scripts/test-services.ts
-- sh -c 'pnpm test:postgres && pnpm test:e2e'` — one container pair,
sequential, so PostgreSQL and the browser tier never compete for the same
cores; nested `test-services.ts` invocations no-op their own container
bring-up via the inherited `CUBBY_TEST_SERVICES=external`. (2) `playwright.config.ts`
`trace: "retain-on-failure"` (the only setting that actually records anything
with `retries: 0`). (3) `waitForAppHydration` now throws one of two distinct
messages — `"Shell not hydrated within budget at <url> (get-session: <status>)"`
or `"SSR rendered the unauthenticated shell at <url> (get-session: <status>)"`
— fetching the `get-session` status once, only after the retry budget is
already exhausted, so the diagnostic fetch itself never adds latency to the
retry loop. The next flake's error message will name which of the two
happened and what the session endpoint reported at that moment, without a
trace re-run. (4) `tooling/e2e-workers.ts` accepts `CUBBY_E2E_WORKERS` up to 4
(was 3), for future headroom experiments; the local default stays 3 (see
below). No timeouts were raised and no retries were added.

B1's E2E-side spec consolidation shrank the same-day surface: the four
per-viewport specs `declared-vendor-display`, `declared-ledger-display`,
`declared-record-lists`, and `financial-transaction-fields` (8 tests, column
rendering already covered by `entity-display.<entity>.unit.test.tsx`) became
one desktop case in `declared-record-lists.spec.ts` plus one mobile case
folded into `mobile.entity-views.spec.ts`; the other three specs were
deleted. Sixteen `page.screenshot({ path: testInfo.outputPath(...) })`
attachments that nothing read were deleted from those and other specs. Total
discovered E2E tests: **58** (`pnpm --filter @cubby/web exec playwright test
--list`), down from the historical 65.

Measured on the same 8-core, 24 GiB Mac, `container` 1.4.1 — **not idle**: the
host ran three other worktrees' Nx daemons and their own test/build work
throughout this session (1-minute `uptime` load ranged 4 to 26 across the
runs below, against the plan's idle-host assumption). Given that, this table
is evidence of direction, not a clean absolute baseline; re-run the matrix on
an idle host before trusting the wall times as a new target.

| Config | Runs | Wall (s) | E2E wall (s, solo) | Flakes | Load (1-min) before → after |
|---|---|---|---|---|---|
| Concurrent (old), full crash | 1 | 180 | — (e2e never ran a test: `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL`) | run-ending crash | 4.6 → n/a |
| Concurrent (old), completed | 1 | 159 | — | 4/58 (see below) | 8.9 → 10.8 |
| Sequential (adopted) | 4 | 207, 266, 162, 202 | — | 4/58, same 4 each run | 4.5→13.6, 16.8→19.3, 15.7→11.5, 8.7→11.6 |
| E2E alone, 3 workers | 2 | — | 155, 137 | 4/58 both | 11.4→26.4, 3.1→14.0 |
| E2E alone, 4 workers | 1 | — | 134 | 4/58 | 7.9 → 12.4 |

Every failure across every config, every worker count, and even the one run
that *started* from a near-idle 3.1 load (climbing to 14 purely from the
run's own postgres+integresql+3-browser-worker footprint) was the *same* four
tests: `create-recipe-full-flow.spec.ts`, `product-ssr.spec.ts`,
`mobile.phone-workflows.spec.ts`, `http-resource-api.spec.ts` — three of them
exactly the hydration-timeout shape this fix targets (a `Create|Save|Move`
button or click target not appearing within budget) and the fourth a
session-revocation cache race. None of those four files are touched by this
change (`git status` confirms it), and none were touched by any commit on
this branch; they fail identically regardless of `test:all` sequencing or
worker count, including from a near-idle start. That rules out "this
change caused it" and points instead to a **pre-existing host-contention
sensitivity**: these are the tests closest to their own timeout budget, so
they are the first to tip over the instant *any* significant load appears —
even the load the E2E run's own three browser workers plus PostgreSQL
generate by themselves on this 8-core machine. This is a narrower claim than
H1 as originally framed (which blamed the specific PostgreSQL+Playwright
`test:all` concurrency): the sequential fix removes that specific
concurrency, but E2E alone still saturates the box enough to reproduce the
same four failures. The concurrent shape's one clearly worse behavior is its
failure mode at the high end: a full crash with zero test output, versus the
sequential shape's four-for-four completed runs that at least name their
failures.

**Decision:** adopt the sequential `test:all` regardless — it removes the
specific PostgreSQL/Playwright CPU oversubscription by construction, and its
worst observed outcome (a reported failure) is strictly more debuggable than
the concurrent shape's worst observed outcome (a silent crash). Keep the local
E2E worker default at 3: the 3-vs-4-worker sample is too small and too noisy
(load swung 12+ points within single runs) to justify moving the default;
`CUBBY_E2E_WORKERS=4` is available for a follow-up comparison on an idle host
now that the cap allows it. **This session did not reach 0 flakes** in any
sequential run: the same four pre-existing, unrelated tests failed every
time, including from a near-idle start, so they are not attributable to the
sequencing fix and are out of this change's scope — track them separately as
a follow-up (their own resource footprint, not `test:all`'s scheduling, is
the lead). Re-run `pnpm test:all` ×3–5 on a host with nothing else running at
all (not just "idle-ish") to confirm the sequencing fix's flake rate in
isolation from these four.

*Superseded 2026-09-17:* the local macOS E2E worker default moved from 3 to
2. At three workers the iPhone WebKit project flaked across four unrelated
specs whenever other sessions' gates loaded the host; every run at
`CUBBY_E2E_WORKERS=2` was clean. `CUBBY_E2E_WORKERS=3|4` remain available for
an idle-host comparison.

A warm targeted PostgreSQL family passed 24 tests in 12.38s including service
startup and cleanup. An earlier Docker sample took 18.07s, but was not a matched
warm comparison, so it is not evidence of a runtime speedup. Two independent
worktrees passed that family concurrently with distinct endpoints; stopping one
pair left the other working. Repeated runs and cancellation left no Apple
containers or volumes, while images remained cached. After validation, the
macOS Docker application login item was confirmed disabled and Docker Desktop
was quit. Its data and privileged helper remain installed for rollback; the
Docker VM and application processes are not running.

The full/high-risk GitHub target is a three-minute median and four-minute p95,
without exceeding the prior full-run total of 16m54s raw runner time or its
rounded job-minute equivalent. PostgreSQL targets 2m15s and each browser lane
2m45s. Compare at least ten exact-head runs; queue time and cold browser-cache
misses are reported separately rather than hidden by retries.

Deleted database and browser cases are not a ban on their behavior. Restore a
case at the lowest tier that can fail: pure grouping, filtering, ranking,
formatting, registry, and projection contracts belong in table-driven unit
tests; component interaction belongs in jsdom. The rewrite keeps, among other
things, Collection matrix, tool-gallery, Product movement, conversion
coverage, title-size detection, Wish presentation, data-quality, and Location
vision behavior in those fast tiers. Search grouping was moved to the exported
pure grouping seam. Removal cascades remain state-based PostgreSQL contracts;
the fast tier keeps only their compile-time invariants rather than impersonating
a Drizzle transaction. Do not put a pure case back into PostgreSQL merely to
increase database coverage, and do not replace PostgreSQL with a mock database
interface.

### Final join of the code-deletion pass (2026-09-16)

Measured on the merged branch, host shared with an unrelated build (1-minute
load 5–20 throughout), so wall clocks are pessimistic:

| gate | result |
|---|---|
| `pnpm test:all` (sequential) | 3:13, 2:54, 2:37 — 0 failures, 0 flakes |
| `pnpm test:e2e` alone (fresh `build:cf`) | 1:51 for 65 tests (was ~2:20 standalone) |
| `pnpm test:postgres` | 77 files / 422 tests; median 27s vs 29s for the eight family bundles |
| `@cubby/web` vitest duration | 24.2s |
| `pnpm verify:local:full` (`--parallel=1`) | 6:49, all 11 targets across 14 projects |
| `pnpm verify:local:full` (default parallelism, rejected) | 10:54 and red — unit tier 196s, timeouts |
| `pnpm exec oxlint .` with the two new plugin rules | 1.9s |

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

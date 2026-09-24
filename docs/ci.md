# Continuous integration

GitHub Actions routes checks by affected files on pull requests and `main`
pushes. Required checks on the exact PR head are the merge gate. Merging to
`main` independently deploys every production Worker, including after a
documentation-only change; deployment never waits for post-merge CI.

## Local verification

`scripts/ci-change-scope.ts` classifies hosted changes for the `Scope` job;
unknown paths and manual runs select every lane. Local affected-ness and
scoping remain Nx's job: every gate is a target on the project whose files it
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
job's `apple` output. The scope job reads the PR file list or the files in a
`main` push. Native source, FFI, Rust bridge, shared API schemas, and CI policy
changes select Apple; an Apple README alone does not. A skipped job still
satisfies its required status check. `Apple package tests` runs `swift test --package-path
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
`main`. `Scope` and `Validation` retain stable required names. A documentation-only
change runs Oxfmt and offline relative-link validation; generated Markdown also
runs `generate:check`. Every Markdown file under `docs/` is rendered in the web
app, so edits there select the web lanes.
Native, auxiliary, Rust, web, and PostgreSQL/E2E lanes run only when their inputs
can affect them. A manual run selects all lanes. `Web checks` is the stable
required aggregate: it checks the web, PostgreSQL, and browser matrix results
whenever web validation is selected. The browser lanes test the exact bundle
produced by the node test lane and retain the discovery and no-skip guard;
desktop Chromium runs as two Playwright shards (two workers each). Phone-web and
WebKit browser coverage was removed from PR CI and the Playwright suite; native
checks remain separate. There is no coverage mode.
Browser shards save sanitized case results, a run manifest, and SHA-256
checksums on success and failure for seven days. The manifest records the tested
commit, build fingerprint, and replay arguments; a dirty local run or unmatched
build is marked as not exactly replayable. The manually dispatched native
simulator E2E saves the same bundle format with its app build fingerprint and
runtime. Raw reports, traces, screenshots, and logs stay local because they may
contain household data or credentials.
`test-postgres` and `test-e2e` each
declare their own `postgres`/`integresql` `services:` block — GitHub Actions
YAML has no anchors and no reusable construct that fits here, so the
duplication is accepted rather than worked around. Affected jobs wait on
`Scope`. The separate Markdown link workflow remains available manually, and
the same check runs automatically in `Validation` for Markdown changes. The
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

A `warm-apple-ffi` job in `ci.yaml` runs on `main` pushes selected for Apple and
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

The `main` ruleset requires `Scope`, `Validation`, `Web checks`, auxiliary,
Rust, and Apple checks. Non-matrix jobs that are unaffected are skipped; the
web aggregate verifies every selected matrix lane. Keep `strict` disabled so
a green non-conflicting branch need not rebase, allow administrator bypasses,
and do not require human review.

Record ten exact-head public PR runs before changing topology: queue time,
required-check p50/p95, per-lane duration, cache behavior, cancellations, and
merge-to-deploy duration. The target is a 4–7 minute warm critical path and no
more than 10 minutes cold. Optimize only a measured bottleneck; prior evidence
already rejects node_modules caching and extra E2E sharding. The current
two-runner effort targets a typical warm PR near three minutes; track queue and
cold native builds separately.

### Measured decisions

Keep the full experiment tables in Git history; this page records the decisions
that still shape the current checks. When changing CI topology, collect at least
five naturally occurring successful exact-head PR runs before claiming a new
median, and compare queue time, required-check p50/p95, cache misses,
cancellations, job-minutes, and merge-to-deploy time. Do not infer a speedup
from a single warm run or a different host load.

- Desktop Chromium uses two shards. More workers per runner and three shards
  did not improve the required-check critical path enough to justify their
  setup and contention costs. Phone and WebKit browser projects were removed
  from PR CI; device-dependent phone behavior still needs device acceptance.
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

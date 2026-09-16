# Continuous integration

Routine verification runs locally. GitHub hosts the complete suite only when
explicitly requested; merging to `main` automatically builds and deploys affected
production Workers without running tests or E2E again.

## Local verification

`scripts/ci-scope.ts`'s hand-rolled path classifier is gone. Affected-ness and
scoping are now Nx's job: every gate is a target on the project whose files it
covers (`apps/web/project.json` — `postgres`, `build-cf`, `e2e`,
`workers-tests`; `recipebridge/project.json` and `cubby-ffi/project.json` —
`rust`; `apps/apple/project.json` — `apple`; the repo-wide `generate`, `types`,
`lint`, `format`, `knip` gates stay on root `project.json`'s `cubby-checks`
project), each with `inputs` that hash only the files it actually reads. A
target whose inputs are unchanged since the last run replays its cached result
instead of re-executing.

After committing, run `pnpm verify:local`
(`nx run-many -t generate,types,lint,format,knip,test,postgres,build-cf,e2e,rust,apple`).
It first rejects an uncommitted or untracked working tree, then runs every
target across every project — most replay from cache on a small change, so an
unaffected native/Postgres/E2E gate costs a cache lookup, not a rebuild. It
deploys nothing. `pnpm verify:local:full` sets `NX_SKIP_NX_CACHE=true` first,
forcing every target to actually execute regardless of cache state — use it
for high-risk changes or before a release. Both print each step's elapsed
seconds and a total (Nx's own `--outputStyle=stream` reporting).

**Pre-push.** `.husky/pre-push` runs `pnpm verify:push`
(`nx affected -t typecheck,test,build-cf,postgres,e2e,rust,apple && pnpm check`):
a scoped fast gate that never escalates to the full suite. `nx affected` compares
the working tree's content hashes against `nx.json`'s `defaultBase`
(`origin/main`; override per-invocation with `nx affected --base=<ref>` or the
`NX_BASE` env var) and runs each named target only on the projects whose
inputs actually changed — a web-only change skips `rust`/`apple` entirely
rather than a hand-written prefix classifier deciding to skip them. `pnpm
check` (repository-wide `generate`/`types`/`lint`/`format`/`knip`) always runs
afterward regardless of scope.

Node 24, pnpm 12.3.4, Rust/wasm-pack, Apple `container` on macOS (external PostgreSQL/IntegreSQL on Linux) and Playwright
browsers must be available. Follow [validation guidance](agents/validation.md) for database setup.
PostgreSQL remains the authoritative integration tier; Playwright retains a
single worker and no retries. Both tiers reject an empty selection or an
unexpected skipped test without freezing the suite to a hand-maintained count.
Browser verification always follows the current web build (the `e2e` target
`dependsOn: ["build-cf"]`). Pre-commit still runs `pnpm check`.

A change under `apps/apple/` or `cubby-ffi/` selects the `apple` Nx target
(`scripts/apple-check.sh`, the former `ci-scope.ts` `runAppleCheck` body): `node
scripts/ensure-apple-ffi.ts` (Nx-cached xcframework + UniFFI shim; a stale
committed `cubby_ffi.swift` fails as a dirty tree), `xcodegen
generate --use-cache`,
`swift test --package-path apps/apple/CubbyKit`,
`apps/apple/scripts/generate-openapi.sh --check`, then an `xcodebuild` simulator
build. It skips itself (with a message, not a failure) when `xcode-select -p`
fails, so a machine without Xcode still passes — `pnpm apple check` runs the
same script directly. The `rust` target runs fmt/clippy/test per crate
(`recipebridge/project.json`, `cubby-ffi/project.json`); `verify:local(:full)`
runs both projects' `rust` target regardless of what changed, `verify:push`
only the affected one. There is no hosted macOS runner yet — the `apple`
target only runs locally; a `workflow_dispatch` job behind a `run_ios` input is
a possible follow-up, not implemented.

## Optional hosted suite

Once this workflow is on the default branch, request full verification with:

```sh
gh workflow run ci.yaml --ref <branch> -f mode=verify
```

Use `-f mode=coverage` for full instrumented coverage. Neither mode deploys.
There are no automatic PR verification or scheduled coverage runs. The separate
Markdown link workflow is also manual. Opt-in Claude workflows remain available.
Hosted browser lanes test the exact bundle produced by the node test lane and
retain the same discovery and no-skip guard as local runs. Explicit manual
preview dispatch remains available; verification no longer dispatches previews
automatically.

## Deployment

`.github/workflows/deploy.yaml` runs on `main` pushes. A `dorny/paths-filter`
step (replacing the deleted `scripts/ci-scope.ts` `classifyPaths`) classifies
changed paths into `web`/`usda`/`upc` filters, builds the affected Workers and
deploys them. Unlike the deleted classifier, an entirely unrecognised
top-level path is not a fail-safe "deploy everything" — add the path to the
filter(s) it should affect. Each Worker serializes
production deployments and checks that the commit is still current main before
building and again before deploying. Production never depends on a test job.
This trusts verification performed before merging. Builds/deployments still use
GitHub Actions minutes; this policy removes repeated hosted verification costs,
not all Actions usage. No self-hosted runner or Cloudflare Builds is required.
The Cloudflare CI pilot is retired; its evaluation remains historical.

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

Seven warm `NX_SKIP_NX_CACHE=true pnpm test:all` samples executed the tests
(no replayed Nx results). Each PostgreSQL tier passed all 407 contracts. The
browser tier discovered 65 tests, with no skips or retries:

| Sample | Total wall time | Browser result |
|---|---|---|
| 1 | 242.48s | 65 passed |
| 2 | 250.21s | 65 passed |
| 3 | 259.69s | 64 passed; calendar hydration timeout |
| 4 | 215.70s | 65 passed |
| 5 | 248.93s | 65 passed |
| 6 | 378.90s | 63 passed; placement navigation and mobile hydration timeouts |
| 7 | 396.65s | 64 passed; relationship page hydration timeout |

The median across all samples was **250.21s**; four samples passed completely.
This exceeds the local-suite target above and does not establish a speedup over
Docker. Host load reached 76 on eight cores during investigation, with Spotlight
using over two cores; contention is a possible cause, not a proven explanation.
The failing scenarios subsequently passed 10 nutrition repetitions and 12 traced
readiness repetitions. A standalone traced browser run passed all 65 tests in
265.87s. The intermittent readiness failures remain unresolved; no retries or
larger timeouts were added to hide them.

The worker-scoped browser harness that followed gives every Playwright worker a
separate IntegreSQL clone, object store, and Wrangler runtime. A fresh-build
three-worker run passed all 65 tests without retries or skips in **141.59s** and
left zero containers and volumes. One uncached one-worker `test:all` sample also
passed all 407 PostgreSQL contracts and the browser lane in 397s. The planned
five-sample 1/2/3 comparison stopped when the host became actively used; a
concurrent two-worker sample timed out one PostgreSQL contract, so those
`test:all` timings are not a valid worker-count comparison. The local default
remains three from the earlier browser-only measurements; repeat the full matrix
on an idle host before treating its wall times as a new baseline.

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

# Continuous integration

Routine verification runs locally. GitHub hosts the complete suite only when
explicitly requested; merging to `main` automatically builds and deploys affected
production Workers without running tests or E2E again.

## Local verification

After committing, run `pnpm verify:local` (also the mandatory pre-push hook).
It rejects uncommitted code, includes deleted paths, runs repository checks and
selects affected web, PostgreSQL, browser, build, auxiliary and Rust gates using
`scripts/ci-scope.ts`. Unknown paths fail safe. High-risk changes run the complete
routine suite; `pnpm verify:local:full` forces that suite for any revision.
Use `CUBBY_VERIFY_BASE` to override the default merge base with `origin/main`.
The full command includes WASM preparation, dependency installation/deduplication,
repository checks, workspace and PostgreSQL tests, Rust formatting/lint/tests,
auxiliary builds and a fresh web build. It then runs the fast tests followed by
PostgreSQL and browser tests concurrently through the existing `concurrently`
npm runner. Those two tiers use isolated database templates; a failure stops
the peer and fails verification. It deploys nothing.

Node 24, pnpm 10.34.1, Rust/wasm-pack, local PostgreSQL/IntegreSQL and Playwright
browsers must be available. Follow [validation guidance](agents/validation.md) for database setup.
PostgreSQL remains authoritative with 262 integration tests; Playwright retains
22 browser contracts, a single worker and no retries. Browser verification
always follows the current web build. Pre-commit still runs `pnpm check`.

## Optional hosted suite

Once this workflow is on the default branch, request full verification with:

```sh
gh workflow run ci.yaml --ref <branch> -f mode=verify
```

Use `-f mode=coverage` for full instrumented coverage. Neither mode deploys.
There are no automatic PR verification or scheduled coverage runs. The separate
Markdown link workflow is also manual. Opt-in Claude workflows remain available.
Hosted browser lanes test the exact bundle produced by the node test lane and
retain the existing test-count guards. Explicit manual preview dispatch remains
available; verification no longer dispatches previews automatically.

## Deployment

`.github/workflows/deploy.yaml` runs on `main` pushes. It classifies all changed
paths, builds the affected Workers and deploys them. Each Worker serializes
production deployments and checks that the commit is still current main before
building and again before deploying. Production never depends on a test job.
This trusts verification performed before merging. Builds/deployments still use
GitHub Actions minutes; this policy removes repeated hosted verification costs,
not all Actions usage. No self-hosted runner or Cloudflare Builds is required.
The Cloudflare CI pilot is retired; its evaluation remains historical.

The workflow policy takes effect after merging this branch. On September 7,
2026, the complete warm `pnpm verify:local:full` passed in **124.47 seconds**
on the local ARM Mac. The preceding pre-push run took 289.37 seconds including
about 135 seconds of Rust compilation. These are individual observations, not
a guaranteed runtime; see [local measurements](local-check-performance.md).

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
node --test scripts/ci-scope.test.ts
actionlint -no-color .github/workflows/*.yaml
pnpm run check
```

After a material workflow change, compare at least ten representative runs for
PR p50/p95 wall time, merge-to-deploy time, total job-minutes, cancellations,
and cache behavior.

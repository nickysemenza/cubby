# Continuous integration

Cubby's CI is optimized for two different paths: fast pull-request feedback and
fast, provenance-checked deployment after merge. The workflow definitions stay
focused on executable policy; this document records the design and the measured
experiments that should not be rediscovered from scratch.

## Work selection

`scripts/ci-scope.ts` is the source of truth for path classification. It maps a
change to web, Rust, auxiliary-package, and auxiliary-worker work. A path the
classifier does not recognize deliberately selects every suite and worker.
Documentation, agent configuration, and editor-only files are inert for the
expensive workflow; Markdown still runs the dedicated relative-link workflow.

Ordinary pull requests run affected tests. High-risk paths and manual
`force_full` dispatches run the complete applicable verification suite. Weekly
coverage runs the full instrumented JS, Rust, and PostgreSQL tiers. This avoids
a persistent label turning every follow-up revision into another full run.

PostgreSQL is the only authoritative database backend. The retained integration
suite is capped at 260 contract tests and Playwright at 22 browser-only tests;
CI selects those same manifests with no retries. PGlite is available only
through explicit local developer commands and is not duplicated in CI or
scheduled coverage. The local acceptance command runs the fast tier first, then
PostgreSQL and Playwright concurrently with one browser worker.

On a `main` push, CI looks for the merged pull request and its final successful
CI run. A prior result is reusable only when it came from this repository, has
a policy-versioned provenance marker bound to the PR number and head commit,
and the pull-request head and merged commit have the same Git tree. Web changes
additionally require a live `cf-build` artifact from that successful run.
Anything ambiguous falls back to full verification; it never widens into an
unverified deployment.

## Build and deployment flow

The web Cloudflare bundle is built once in the node-test runner and uploaded
before that runner starts its tests. The single Playwright job starts in
parallel, downloads and tests that exact artifact, and preview and production
deployment consume it unchanged. Co-locating the build removes a runner and a
duplicate dependency setup without removing the build gate.

Production jobs serialize per worker and re-check that their workflow SHA is
still current `main` after acquiring the deployment slot. A burst of merges can
therefore verify independently while stale commits decline to deploy.

Full JS and Rust coverage runs Wednesday at 10:17 UTC, or through the manual
coverage mode. PR verification uses the same tests without instrumentation.

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

# Continuous integration

Cubby's CI is optimized for two different paths: fast pull-request feedback and
fast, provenance-checked deployment after merge. The workflow definitions stay
focused on executable policy; this document records the design and the measured
experiments that should not be rediscovered from scratch.

## Work selection

`scripts/ci-scope.mjs` is the source of truth for path classification. It maps a
change to web, Rust, auxiliary-package, and auxiliary-worker work. A path the
classifier does not recognize deliberately selects every suite and worker.
Documentation, agent configuration, and editor-only files are inert for the
expensive workflow; Markdown still runs the dedicated relative-link workflow.

On a `main` push, CI looks for the merged pull request and its final successful
CI run. A prior result is reusable only when the pull-request head and merged
commit have the same Git tree. Web changes additionally require a live
`cf-build` artifact from that successful run. Anything ambiguous falls back to
full verification; it never widens into an unverified deployment.

## Build and deployment flow

The web Cloudflare bundle is built once per verification run. Both Playwright
shards download and test that exact artifact while preview and production
deployment consume it unchanged. E2E starts in parallel with the build and
polls for the artifact, preserving the setup head start without duplicating the
bundle build.

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

## Operational checks

Before changing CI, run:

```sh
node --test scripts/ci-scope.test.mjs
actionlint -no-color .github/workflows/*.yaml
pnpm run check
```

After a material workflow change, compare at least ten representative runs for
PR p50/p95 wall time, merge-to-deploy time, total job-minutes, cancellations,
and cache behavior.

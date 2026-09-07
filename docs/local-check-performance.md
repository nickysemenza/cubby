# Local check and calendar performance

Measured September 7, 2026 on ARM macOS with TypeScript 7.0.2. These are local
diagnostics, not a comparison with hosted x86 CI.

## Typechecking

The web typecheck now uses `--checkers 1`. The native compiler otherwise checks
the program with multiple independent type graphs. A single checker reduces
duplicate generic instantiations without excluding files or changing diagnostics.
Incremental checking remains enabled; the service-worker check is unchanged.

Representative cold runs (`--noEmit --incremental false --extendedDiagnostics`,
wrapped with `/usr/bin/time -l`):

| Setting | Files | Instantiations | Wall time | CPU user time | Peak RSS |
| --- | ---: | ---: | ---: | ---: | ---: |
| Default checkers | 7,403 | 21,307,057 | 12.29 s | 50.44 s | 5.93 GB |
| One checker | 7,403 | 10,148,693 | 12.37 s | 21.52 s | 3.07 GB |

This is primarily a memory and CPU improvement, not a demonstrated latency win.
Earlier measurements overlapped trace generation or dependency installation and
are excluded. Two checkers used about 4.03 GB in an exploratory run. A compiler
trace identified a costly literal-union expression in the entity inspector, but
a local annotation did not show a reliable overall improvement and was removed.

The complete warm `pnpm check` baseline took 7.17–7.51 seconds over three runs
(median 7.21 seconds). Revised warm runs took 7.27–10.20 seconds (median
8.11 seconds), about 12% slower at the median in this small sample. Reducing
compiler memory does not eliminate time spent in lint, Knip, and other repository
guards. The first check after changing compiler settings rebuilds its
incremental state and is not a warm measurement.

## Calendar tests and generation

ICS line folding previously allocated a UTF-8 byte array for every character.
An oversized-document test exercised millions of these allocations and timed
out in the hosted pilot. Folding now computes each Unicode code point's byte
width without those allocations. Line limits, continuation spaces, surrogate
handling, and rendered text are preserved.

The existing snapshot and ICS test files took 927 ms of test execution before
the change and 119 ms afterward, including five additional folding cases for
ASCII, two-byte, three-byte, supplementary, and unpaired-surrogate text. End-to-end
test-command duration fell from 3.02 to 2.12 seconds. All 27 tests passed.

## Complete local verification

After the local-verification workflow change, `pnpm verify:local:full` passed
in **124.47 seconds** on the 8-core, 24 GiB ARM Mac, measured with
`/usr/bin/time -p`. This warm run includes WASM preparation, frozen dependency
installation, all repository checks, dependency deduplication, Rust formatting,
Clippy and tests, all Worker builds, workspace tests, PostgreSQL and Playwright.
The PostgreSQL and browser tiers overlap through the existing npm runner after
the fast tier; neither test coverage nor browser worker limits changed.

The preceding full pre-push gate and push took 289.37 seconds, including
52.95 seconds of Clippy compilation and 82 seconds of Rust test compilation.
Warm Clippy and Rust test build phases took 0.15 and 0.19 seconds respectively.
Warm web tests passed all 3,442 cases in 18.87 seconds; PostgreSQL passed all
262 cases in 29.07 seconds, alongside all 22 passing browser tests. Both complete
runs passed. Measurements were taken on code commit `7f7f2c13d` using local Node
26.7.0; hosted configuration continues to pin Node 24. These are two observations
with different cache states, not a controlled before/after comparison or a
measurement of aggregate process-tree memory. The typechecker RSS measurements
above remain separate.

## Excluded claims

Changing Rust test/Clippy order was explored but not retained locally. The
three-second Clippy result reused earlier Clippy output and was not a valid cold
comparison. No tests, required checks, production APIs, or schemas were removed
or weakened to obtain these results.

## Declarative local tooling

`project.json` replaces the custom check runner. Nx runs two tasks concurrently;
`NX_PARALLEL` overrides that limit. Existing package scripts and mandatory Git
hooks remain the entrypoints. Nx Cloud and analytics are disabled; the shared
local task cache has a 2 GB limit with built-in eviction. Set
`NX_SKIP_NX_CACHE=true` for a fresh run. Workspace typechecking also caps package
concurrency at two.

Cached checks hash the workspace source/configuration, lockfile, patches,
Node/platform, and Node options. Typechecks additionally hash generated WASM
declarations. Fast tests additionally hash the commit, ignored WASM/environment
files, and test-specific environment settings. MCP App bundles and an empty
failure-summary file are restored, so an older failed run cannot leave a stale
failure list after a successful cache hit. Git-index-sensitive soft-delete
checks, Knip, network audit, tooling tests, bindings/OpenAPI, PostgreSQL, browser
acceptance, and Git-aware verification remain live.

Deleted: `run-checks.ts` (192 lines), `run-checks.test.ts` (111), and
`setup-agent-environment.ts` (49). Required-gate assertions move into the existing
configuration tests. Total `scripts/` lines fall from 12,955 to 12,692; the two
Nx configurations add 137 lines, for a net reduction of 126 lines across those
files. No new custom tooling scripts were added.

Setup uses `pnpm install --frozen-lockfile && node scripts/ensure-wasm.ts`.
Claude's startup condition was exercised against a main checkout (skips setup)
and a linked worktree (invokes setup).

Use external measurement tools:

```sh
hyperfine --warmup 1 --runs 10 'pnpm check'
hyperfine --warmup 1 --runs 10 'NX_SKIP_NX_CACHE=true pnpm check'
```

A lint-cache probe passed, failed after adding a debugger statement, then reused
the successful result after source restoration in 2.27 seconds. The first run
took 42.09 seconds under contention; these are not idle-machine guarantees.
Node 26.7.0 was used locally; `.nvmrc` still requests Node 24.

### Shared dependency-store experiment: not adopted

Disposable checkouts of the pre-change revision used the same lockfile, without
household environment files. Warm-store pnpm 10.34.1 trials took 36.74/60.04
seconds with isolated virtual stores and 74.99/103.67 seconds with the global
layout. Other local jobs were compiling throughout these measurements.

This matches [pnpm #11112](https://github.com/pnpm/pnpm/issues/11112), where fresh
projects reimport populated global entries. pnpm 11.22.0 with the existing
resolution/build policy took 357.16 seconds to populate its separate store,
then 10.66 seconds for a fresh install. Its checkout-local dependency links
reported 1.8 MB versus about 1.4 GB for the isolated layout. These `du` totals
exclude the shared store and do not measure physically reclaimed APFS blocks.
Concurrent minimal projects correctly resolved distinct Zod 3 and 4 versions.

The application validation rejected adoption: the global layout exposed an
undeclared Vitest peer in jest-dom and lost React declaration resolution in
Lucide/chart libraries. A narrow Vitest peer extension fixed the UI import, but
TypeScript's `typeRoots` did not fix the React declarations. `preserveSymlinks`
was also rejected: a negative type probe accepted an invalid chart-axis property,
showing that seemingly improved compilation would weaken checking. This matches
the class of failures in [pnpm #9739](https://github.com/pnpm/pnpm/issues/9739).
All experimental dependency and compiler adjustments were reverted.

Keep pnpm 10 and its existing storage layout until shared-store compatibility
can pass the complete type/build/test gates without a growing set of local
workarounds. No Bun migration is justified by this evidence. This patch reduces
custom orchestration and repeated computation; it does **not** claim a reduction
in dependency disk allocation. pnpm's existing content-addressed storage and the
existing shared Cargo target cache remain in use.

### Retained patch validation (2026-09-07)

Code revision: `78376ae04819dc7e8cc58deb7b6abeb283bfdbf9`.
Measurements were taken on the same busy ARM Mac and are observations, not a
controlled speedup claim. Cold Cargo compilation is excluded from the setup
comparison, as requested.

| Measurement | Observed result |
| --- | --- |
| Original runner, initial `pnpm check` sample | 181.26 s |
| Retained `pnpm check:all`, uncached | 253.59 s; all 12 gates passed |
| Retained warm `pnpm check` | 13.83 s overall; 6/8 tasks cached |
| Mandatory pre-commit check | Passed; Nx task duration 3.9 s |
| Fresh worktree `pnpm agent:setup` | 67.72 s, including 45.8 s install and 16.22 s WASM preparation |
| Existing worktree `pnpm agent:setup` | 17.00 s; tracked files remained clean |
| Lint cache reused by a separate worktree | 1/1 cache hit; Nx task duration 397 ms |

The full and fast check commands have different gate sets; do not compare their
elapsed times as equivalent workloads. The warm six-second target was missed.
No successful full-fast-test cache timing was recorded because the aggregate
suite encountered timeouts. All disposable benchmark worktrees were removed.

`pnpm verify:local:full` passed frozen installation, WASM preparation,
`check:all`, deduplication, Rust formatting/Clippy, 251 Rust tests (one existing
ignored doctest), and all three Worker builds. It then failed on three
five-second UI test timeouts: date-picker selection, collection-matrix paging,
and workspace navigation. The aggregate web result was 3,439 passed / 3 failed.
All 18 tests across those three files passed in a targeted rerun. An earlier
aggregate run had one MCP catalog-schema timeout; all five tests in that file
also passed alone. No assertion or timeout was relaxed.

The remaining acceptance tiers were run separately: all 262 PostgreSQL tests
passed, and the browser command with the required 22-test count exited
successfully. The full verifier is **not green**; targeted successes do not
replace its failed aggregate result. Failed Nx tasks returned nonzero and were
not cached. A separate hook probe verified that pre-commit propagates a failing
`pnpm check` exit status.
